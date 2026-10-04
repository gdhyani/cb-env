import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocketServer } from "ws";

// The daemon runs from the build (global setup compiles it); load the built IPC client so paths line up.
const ipc = require("../../dist/shared/agent-ipc.js") as typeof import("../../src/shared/agent-ipc");
const { saveServerCredentials } =
  require("../../dist/shared/credentials.js") as typeof import("../../src/shared/credentials");
const { agentLogPath, agentSocketPath } =
  require("../../dist/shared/paths.js") as typeof import("../../src/shared/paths");

const TOKEN = "cbd_daemon_test_token_value_000000000000";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** Backend stand-in: bootstrap, an SSE stream the test can push into, and an echo tunnel. */
async function stubBackend() {
  let appName = "v1";
  const streams = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url?.startsWith("/api/agent/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      streams.add(res);
      // res "close" = connection gone (req "close" fires once a bodyless GET has been read).
      res.on("close", () => streams.delete(res));
      return;
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
          plain: { APP_NAME: appName },
          listeners: [
            { resourceId: "r1", kind: "redis", name: "cache", env: { REDIS_URL: "redis://127.0.0.1:{port}" } },
          ],
          redirects: [],
          visibleKeys: [],
        },
      }),
    );
  });
  new WebSocketServer({ server }).on("connection", (ws) => {
    const s = createWebSocketStream(ws);
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setAppName: (v: string) => {
      appName = v;
    },
    push: (event: string, data: unknown = {}) => {
      for (const s of streams) s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}

async function setup(idleMs = 60_000) {
  const backend = await stubBackend();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbd-"));
  const env = { ...process.env, CB_HOME: home, CB_CREDENTIAL_STORE: "file", CB_AGENT_IDLE_MS: String(idleMs) };
  await saveServerCredentials(
    backend.url,
    { token: TOKEN, deviceId: "d1", deviceName: "test", user: { id: "u", name: "U", email: "u@x" } },
    env,
  );
  cleanups.push(async () => {
    const conn = await ipc.connectAgent(env);
    if (conn) {
      conn.send({ type: "stop" });
      await conn.next("stopping").catch(() => undefined);
    }
  });
  return { backend, env, home };
}

/**
 * Is the agent still listening? Unix: the socket file. Windows named pipes are not files, so probe with a
 * connection that closes at once (callers space probes out so they don't keep the agent busy).
 */
const agentListening = (env: NodeJS.ProcessEnv) =>
  process.platform === "win32"
    ? new Promise<boolean>((resolve) => {
        const s = net.connect(agentSocketPath(env));
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      })
    : Promise.resolve(fs.existsSync(agentSocketPath(env)));

const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000, everyMs = 100) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
};

describe("background agent daemon (FR-AGT-001, FR-AGT-006, FR-AGT-007)", () => {
  it("FR-AGT-001 starts once per CB_HOME, attaches an environment and writes its snapshot; the token never reaches the log", async () => {
    const { backend, env } = await setup();
    const conn = await ipc.ensureAgent(env);
    conn.send({ type: "attach", server: backend.url, projectId: "p1", environment: "development" });
    const attached = await conn.next("attached");
    expect(attached.type).toBe("attached");
    if (attached.type !== "attached") return;
    const snapshot = JSON.parse(fs.readFileSync(attached.snapshotFile, "utf8"));
    expect(snapshot.env.APP_NAME).toBe("v1");
    expect(snapshot.env.REDIS_URL).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);

    const again = await ipc.ensureAgent(env);
    again.send({ type: "status" });
    const status = await again.next("status");
    if (status.type !== "status") throw new Error("no status");
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]).toMatchObject({ projectSlug: "shop", environment: "development", clients: 1 });

    // A second daemon process for the same home exits immediately (single instance).
    const second = spawnSync(process.execPath, [ipc.agentEntry()], { env, timeout: 5000 });
    expect(second.status).toBe(0);
    again.send({ type: "status" });
    const after = await again.next("status");
    expect(after.type === "status" && after.pid).toBe(status.pid);

    expect(fs.readFileSync(agentLogPath(env), "utf8")).not.toContain(TOKEN);
    conn.close();
    again.close();
  });

  it("FR-AGT-006 relays config changes and revocation to attached clients", async () => {
    const { backend, env } = await setup();
    const conn = await ipc.ensureAgent(env);
    const seen: string[] = [];
    conn.onMessage((m) => seen.push(m.type));
    conn.send({ type: "attach", server: backend.url, projectId: "p1", environment: "development" });
    const attached = await conn.next("attached");
    if (attached.type !== "attached") throw new Error("not attached");
    await waitFor(() => true, 300);

    backend.setAppName("v2");
    backend.push("config.changed");
    expect(await waitFor(() => seen.includes("config.changed"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(attached.snapshotFile, "utf8")).env.APP_NAME).toBe("v2");

    backend.push("access.revoked", { scope: "grant", reason: "access revoked by admin" });
    expect(await waitFor(() => seen.includes("access.revoked"))).toBe(true);
    const revoked = JSON.parse(fs.readFileSync(attached.snapshotFile, "utf8"));
    expect(revoked.status).toBe("revoked");
    conn.close();
  });

  it("FR-AGT-007 exits on its own when idle, and `stop` shuts it down", async () => {
    const { backend, env } = await setup(1000);
    const conn = await ipc.ensureAgent(env);
    conn.send({ type: "attach", server: backend.url, projectId: "p1", environment: "development" });
    await conn.next("attached");
    conn.close();
    // Watch the socket file: probing with a connection would itself count as a client and keep it alive.
    expect(await waitFor(async () => !(await agentListening(env)), 8000, 1500)).toBe(true);

    const restarted = await ipc.ensureAgent(env);
    restarted.send({ type: "stop" });
    expect((await restarted.next("stopping")).type).toBe("stopping");
    expect(await waitFor(async () => !(await agentListening(env)), 8000, 1500)).toBe(true);
  });
});
