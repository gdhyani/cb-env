import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The daemon runs from the build (global setup compiles it); load the built IPC client so paths line up.
const ipc = require("../../dist/shared/agent-ipc.js") as typeof import("../../src/shared/agent-ipc");
const { agentLogPath } = require("../../dist/shared/paths.js") as typeof import("../../src/shared/paths");
const { saveServerCredentials } =
  require("../../dist/shared/credentials.js") as typeof import("../../src/shared/credentials");

const TOKEN = "cbd_webhook_test_token_value_0000000000";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Push {
  deliveryId: string;
  eventId: string;
  provider: "stripe";
  type: string;
  path: string;
  port: number | null;
  headers: Record<string, string>;
  body: string;
}

/**
 * Backend stand-in with the real delivery contract: an outbox that re-sends unacked webhooks on every stream open
 * and after an ack timeout, plus chaos controls (drop every stream, or stall: sockets stay open but go silent).
 */
async function stubBackend() {
  const streams = new Set<http.ServerResponse>();
  const sockets = new Set<net.Socket>();
  const outbox = new Map<string, { push: Push; sentAt: number }>();
  const acks = new Map<string, Record<string, unknown>>();
  let connections = 0;
  let redelivers = 0;
  const send = (res: http.ServerResponse, push: Push) => {
    res.write(`event: webhook\ndata: ${JSON.stringify(push)}\n\n`);
  };
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    if (req.url?.startsWith("/api/agent/events")) {
      connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      streams.add(res);
      res.on("close", () => streams.delete(res));
      for (const [id, entry] of outbox) if (!acks.has(id)) send(res, entry.push);
      return;
    }
    const ack = /^\/api\/agent\/webhooks\/([^/]+)\/ack$/.exec(req.url ?? "");
    if (ack && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const id = decodeURIComponent(ack[1] ?? "");
        if (parsed.ok) acks.set(id, parsed);
        else if (outbox.has(id)) outbox.set(id, { push: outbox.get(id)?.push as Push, sentAt: 0 });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, meta: { correlationId: "c" }, data: { status: "delivered" } }));
      });
      return;
    }
    if (req.url === "/api/agent/webhooks/redeliver" && req.method === "POST") {
      redelivers += 1;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true, meta: { correlationId: "c" }, data: { queued: 0 } }));
    }
    if (req.url?.startsWith("/api/agent/heartbeat")) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ success: true, meta: { correlationId: "c" }, data: { ok: true } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        meta: { correlationId: "c" },
        data: {
          schema: 1,
          version: 1,
          orgId: "o",
          projectId: "p1",
          projectSlug: "shop",
          environment: "development",
          envId: "e1",
          orgCaCert: "",
          plain: { APP_NAME: "v1" },
          listeners: [],
          redirects: [],
          visibleKeys: [],
        },
      }),
    );
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  // Ack timeout: anything unacked for 400 ms goes out again on the open streams, and heartbeats.
  const timer = setInterval(() => {
    for (const res of streams) res.write("event: heartbeat\ndata: {}\n\n");
    const now = Date.now();
    for (const [id, entry] of outbox)
      if (!acks.has(id) && now - entry.sentAt > 400) {
        entry.sentAt = now;
        for (const res of streams) send(res, entry.push);
      }
  }, 100);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    clearInterval(timer);
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    acks,
    connections: () => connections,
    redelivers: () => redelivers,
    openStreams: () => streams.size,
    deliver: (push: Push) => {
      outbox.set(push.deliveryId, { push, sentAt: Date.now() });
      for (const res of streams) send(res, push);
    },
    dropStreams: () => {
      for (const res of streams) res.socket?.destroy();
    },
    /** Half-open connection: the sockets stay up but nothing more is ever written to them. */
    stall: () => {
      for (const res of streams) {
        streams.delete(res);
        res.on("close", () => undefined);
      }
    },
  };
}

/** The developer's app: records every webhook it receives (path, signature header, body). */
async function devApp() {
  const got: { path: string; signature?: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      got.push({ path: req.url ?? "", signature: req.headers["stripe-signature"] as string, body });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, got };
}

async function setup() {
  const backend = await stubBackend();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbw-"));
  const env = {
    ...process.env,
    CB_HOME: home,
    CB_CREDENTIAL_STORE: "file",
    CB_EVENTS_IDLE_MS: "600",
    CB_EVENTS_BACKOFF_MAX_MS: "300",
  };
  await saveServerCredentials(
    backend.url,
    {
      token: "cbr_refresh_token_for_webhook_test_0000",
      accessToken: TOKEN,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceId: "d1",
      deviceName: "test",
      user: { id: "u", name: "U", email: "u@x" },
    },
    env,
  );
  cleanups.push(async () => {
    const conn = await ipc.connectAgent(env);
    if (conn) {
      conn.send({ type: "stop" });
      await conn.next("stopping").catch(() => undefined);
    }
  });
  return { backend, env };
}

const push = (i: number): Push => ({
  deliveryId: `del_${i}`,
  eventId: `evt_${i}`,
  provider: "stripe",
  type: "payment_intent.succeeded",
  path: "/api/webhooks/stripe",
  port: null,
  headers: { "content-type": "application/json", "stripe-signature": `t=1,v1=sig${i}` },
  body: Buffer.from(JSON.stringify({ id: `evt_${i}`, n: i })).toString("base64"),
});

const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("FR-WH-003 agent delivers webhooks to the app run with cb (daemon)", () => {
  it("posts the pushed webhook to the run's webhook port and path, prints a line, and acks", async () => {
    const { backend, env } = await setup();
    const app = await devApp();
    const conn = await ipc.ensureAgent(env);
    const notices: string[] = [];
    conn.onMessage((m) => {
      if (m.type === "notice") notices.push(m.message);
    });
    conn.send({
      type: "attach",
      server: backend.url,
      projectId: "p1",
      environment: "development",
      webhookPort: app.port,
    });
    await conn.next("attached");
    await until(() => backend.connections() >= 1);
    backend.deliver(push(1));
    await until(() => backend.acks.has("del_1"));
    // Attaching an app asked the backend for anything that waited for it (review I4).
    expect(backend.redelivers()).toBeGreaterThanOrEqual(1);
    expect(app.got).toEqual([
      { path: "/api/webhooks/stripe", signature: "t=1,v1=sig1", body: JSON.stringify({ id: "evt_1", n: 1 }) },
    ]);
    expect(backend.acks.get("del_1")).toMatchObject({ ok: true, status: 200 });
    await until(() => notices.some((n) => /webhook stripe payment_intent\.succeeded → 200/.test(n)));
    conn.close();
  });

  it("soak: dropped streams and silent stalls during a burst — every webhook reaches the app exactly once", async () => {
    const { backend, env } = await setup();
    const app = await devApp();
    const conn = await ipc.ensureAgent(env);
    conn.send({
      type: "attach",
      server: backend.url,
      projectId: "p1",
      environment: "development",
      webhookPort: app.port,
    });
    await conn.next("attached");
    await until(() => backend.connections() >= 1);

    const N = 60;
    for (let i = 0; i < N; i++) {
      backend.deliver(push(i));
      if (i % 10 === 3) backend.dropStreams(); // network blip / backend restart
      if (i % 20 === 7) {
        await until(() => backend.openStreams() > 0);
        backend.stall(); // half-open connection: socket stays, nothing ever arrives on it again
        await new Promise((r) => setTimeout(r, 900)); // > CB_EVENTS_IDLE_MS: the watchdog must notice
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await until(() => backend.acks.size === N, 30_000);
    const ids = app.got.map((g) => JSON.parse(g.body).id as string);
    expect(new Set(ids).size).toBe(N);
    expect(ids).toHaveLength(N); // never twice to the app, however often it was re-pushed
    expect(backend.connections()).toBeGreaterThan(3); // it really reconnected along the way
    conn.close();
  }, 60_000);

  it("review M5: cb run sends the app port with webhook-port (one attach, no second attached reply)", async () => {
    const { backend, env } = await setup();
    const app = await devApp();
    const conn = await ipc.ensureAgent(env);
    const seen: string[] = [];
    conn.onMessage((m) => seen.push(m.type));
    const target = { server: backend.url, projectId: "p1", environment: "development" };
    conn.send({ type: "attach", ...target });
    await conn.next("attached");
    conn.send({ type: "webhook-port", ...target, webhookPort: app.port });
    await new Promise((r) => setTimeout(r, 200));
    backend.deliver(push(900));
    await until(() => backend.acks.has("del_900"));
    expect(app.got.map((g) => JSON.parse(g.body).id)).toEqual(["evt_900"]);
    expect(seen.filter((t) => t === "attached")).toHaveLength(1);
    const log = fs.readFileSync(agentLogPath(env), "utf8");
    expect(log.match(/client attached/g)).toHaveLength(1);
    conn.close();
  });
});
