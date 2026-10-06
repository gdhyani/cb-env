import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentEvent, subscribeAgentEvents } from "../../src/agent/events";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** SSE endpoint whose behaviour each test scripts per connection. */
async function sse(onConnect: (res: http.ServerResponse, n: number, token: string) => void) {
  let n = 0;
  const tokens: string[] = [];
  const server = http.createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    tokens.push(token);
    n += 1;
    onConnect(res, n, token);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, connections: () => n, tokens };
}
const open = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write("event: ready\ndata: {}\n\n");
};
const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

function subscribe(url: string, events: AgentEvent[], extra: Partial<Parameters<typeof subscribeAgentEvents>[0]> = {}) {
  const sub = subscribeAgentEvents({
    serverUrl: url,
    getToken: async () => "t1",
    envId: "e1",
    correlationId: "c",
    onEvent: (e) => events.push(e),
    idleMs: 300,
    tickMs: 50,
    wakeGapMs: 5_000,
    backoff: { baseMs: 20, maxMs: 100 },
    ...extra,
  });
  cleanups.push(() => sub.close());
  return sub;
}

describe("FR-AGT-006 event stream that survives days (watchdog, wake, token, webhook)", () => {
  it("reconnects when the stream goes silent (no heartbeat within the idle window)", async () => {
    const server = await sse((res) => open(res)); // then silence forever
    const events: AgentEvent[] = [];
    subscribe(server.url, events);
    await until(() => server.connections() >= 3);
    // The server counts a connection on arrival; the client sees its "ready" a moment later (slow CI).
    await until(() => events.filter((e) => e.type === "ready").length >= 3);
    expect(events.filter((e) => e.type === "ready").length).toBeGreaterThanOrEqual(3);
  });

  it("stays on one connection while heartbeats keep arriving", async () => {
    const server = await sse((res) => {
      open(res);
      const t = setInterval(() => res.write("event: heartbeat\ndata: {}\n\n"), 100);
      res.on("close", () => clearInterval(t));
    });
    subscribe(server.url, []);
    await new Promise((r) => setTimeout(r, 1000));
    expect(server.connections()).toBe(1);
  });

  it("reconnects at once after the machine sleeps (timer gap)", async () => {
    const server = await sse((res) => {
      open(res);
      const t = setInterval(() => res.write("event: heartbeat\ndata: {}\n\n"), 50);
      res.on("close", () => clearInterval(t));
    });
    subscribe(server.url, [], { idleMs: 60_000, wakeGapMs: 200 });
    await until(() => server.connections() === 1);
    const block = Date.now() + 500; // a frozen process looks like a sleeping laptop to its timers
    while (Date.now() < block) {
      /* spin */
    }
    await until(() => server.connections() >= 2);
  });

  it("401: asks for a new token (naming the rejected one) and retries without a long wait", async () => {
    const server = await sse((res, _n, token) => {
      if (token === "old") return void res.writeHead(401, { "content-type": "application/json" }).end("{}");
      open(res);
    });
    const asked: (string | undefined)[] = [];
    subscribe(server.url, [], {
      getToken: async (rejected) => {
        asked.push(rejected);
        return rejected === "old" ? "new" : "old";
      },
    });
    await until(() => server.tokens.includes("new"));
    expect(asked).toEqual([undefined, "old"]);
  });

  it("login gone: reports it once and keeps retrying (a later cb login recovers)", async () => {
    const server = await sse((res) => open(res));
    let loggedIn = false;
    const lost: string[] = [];
    subscribe(server.url, [], {
      getToken: async () => {
        if (!loggedIn) throw Object.assign(new Error("not logged in"), { code: "NOT_LOGGED_IN" });
        return "t";
      },
      onAuthLost: (m) => lost.push(m),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(lost).toHaveLength(1);
    loggedIn = true;
    await until(() => server.connections() === 1);
  });

  it("parses webhook events and skips malformed ones without dropping the stream", async () => {
    const push = {
      deliveryId: "d1",
      eventId: "evt_1",
      provider: "stripe",
      type: "payment_intent.succeeded",
      path: "/webhooks/stripe",
      port: null,
      headers: { "stripe-signature": "t=1,v1=x" },
      body: Buffer.from("{}").toString("base64"),
    };
    const server = await sse((res) => {
      open(res);
      res.write(`event: webhook\ndata: ${JSON.stringify({ deliveryId: 5 })}\n\n`);
      res.write("event: webhook\ndata: {not json\n\n");
      res.write(`event: webhook\ndata: ${JSON.stringify(push)}\n\n`);
      res.write("event: config.changed\ndata: {}\n\n");
    });
    const events: AgentEvent[] = [];
    subscribe(server.url, events, { idleMs: 60_000 });
    await until(() => events.some((e) => e.type === "config.changed"));
    // generation defaults to 0, so pushes from a backend without replays still parse.
    expect(events.filter((e) => e.type === "webhook")).toEqual([{ type: "webhook", push: { ...push, generation: 0 } }]);
    expect(server.connections()).toBe(1);
  });
});
