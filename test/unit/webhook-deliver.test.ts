import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWebhookDeliverer, type WebhookPush } from "../../src/agent/webhooks";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function app(status = 200) {
  const got: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(status).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { port: (server.address() as AddressInfo).port, got };
}

const push = (over: Partial<WebhookPush> = {}): WebhookPush => ({
  deliveryId: "d1",
  generation: 0,
  eventId: "evt_1",
  provider: "stripe",
  type: "payment_intent.succeeded",
  path: "/webhooks/stripe?x=1",
  port: null,
  headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=abc" },
  body: Buffer.from('{"id":"evt_1","amount":500}').toString("base64"),
  ...over,
});

function deliverer(port: () => { attached: boolean; port?: number }) {
  const acks: { id: string; body: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const d = createWebhookDeliverer({
    appPort: port,
    ack: async (id, body) => {
      acks.push({ id, body: { ...body } });
    },
    notify: (m) => notices.push(m),
    timeoutMs: 1000,
  });
  return { d, acks, notices };
}

describe("FR-WH-003 agent delivers webhooks to the app on 127.0.0.1 (byte-exact, ack, once)", () => {
  it("posts the exact bytes and signed headers to the app's path and acks its status", async () => {
    const a = await app(200);
    const { d, acks, notices } = deliverer(() => ({ attached: true, port: a.port }));
    await d.deliver(push());
    expect(a.got).toHaveLength(1);
    expect(a.got[0]?.path).toBe("/webhooks/stripe?x=1");
    expect(a.got[0]?.body).toBe('{"id":"evt_1","amount":500}');
    expect(a.got[0]?.headers["stripe-signature"]).toBe("t=1,v1=abc");
    expect(acks).toEqual([{ id: "d1", body: expect.objectContaining({ ok: true, status: 200 }) }]);
    expect(notices[0]).toMatch(/webhook stripe payment_intent\.succeeded → 200/);
  });

  it("a repeated delivery id is re-acked with the remembered result, never posted twice", async () => {
    const a = await app(200);
    const { d, acks } = deliverer(() => ({ attached: true, port: a.port }));
    await d.deliver(push());
    await d.deliver(push());
    expect(a.got).toHaveLength(1);
    expect(acks).toHaveLength(2);
    expect(acks[1]?.body).toMatchObject({ ok: true, status: 200 });
  });

  it("an app error is acked as not delivered (the backend retries) and the next attempt is posted again", async () => {
    const a = await app(500);
    const { d, acks } = deliverer(() => ({ attached: true, port: a.port }));
    await d.deliver(push());
    await d.deliver(push());
    expect(a.got).toHaveLength(2);
    expect(acks[0]?.body).toMatchObject({ ok: false, status: 500 });
  });

  it("app not listening / no cb run attached → not delivered with a clear reason", async () => {
    const { d, acks } = deliverer(() => ({ attached: true, port: 1 }));
    await d.deliver(push({ deliveryId: "d2" }));
    expect(acks[0]?.body).toMatchObject({ ok: false });
    expect(String(acks[0]?.body.error)).toMatch(/127\.0\.0\.1:1/);
    const none = deliverer(() => ({ attached: false }));
    await none.d.deliver(push({ deliveryId: "d3", port: null }));
    expect(none.acks[0]?.body).toMatchObject({ ok: false, error: expect.stringMatching(/not running/) });
  });

  it("falls back to the service's default port when the run gave none", async () => {
    const a = await app(204);
    const { d, acks } = deliverer(() => ({ attached: true }));
    await d.deliver(push({ deliveryId: "d4", port: a.port }));
    expect(acks[0]?.body).toMatchObject({ ok: true, status: 204 });
  });

  it("never posts anywhere but 127.0.0.1, whatever the path says", async () => {
    const a = await app(200);
    const { d, acks } = deliverer(() => ({ attached: true, port: a.port }));
    await d.deliver(push({ deliveryId: "d5", path: "//evil.example/x" }));
    await d.deliver(push({ deliveryId: "d6", path: "http://evil.example/x" }));
    expect(a.got.map((g) => g.path)).toEqual(["//evil.example/x"]);
    expect(acks.find((x) => x.id === "d6")?.body).toMatchObject({ ok: false });
  });

  it("review I3: a dashboard Replay (next generation) is posted again; acks name their generation", async () => {
    const a = await app(200);
    const { d, acks } = deliverer(() => ({ attached: true, port: a.port }));
    await d.deliver(push({ deliveryId: "r1" }));
    await d.deliver(push({ deliveryId: "r1" })); // lost ack → same generation → not posted again
    await d.deliver(push({ deliveryId: "r1", generation: 1 }));
    expect(a.got).toHaveLength(2);
    expect(acks.map((x) => x.body.generation)).toEqual([0, 0, 1]);
  });

  it("review I4: no app under cb run is reported as noApp (not a failed attempt)", async () => {
    const none = deliverer(() => ({ attached: false }));
    await none.d.deliver(push({ deliveryId: "n1", port: null }));
    expect(none.acks[0]?.body).toMatchObject({ ok: false, noApp: true });
  });
});
