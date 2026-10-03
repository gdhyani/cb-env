import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StubReply {
  status: number;
  body: unknown;
  contentType?: string;
}

/** Minimal backend stand-in: replies per path and records request headers. */
export async function startStubServer(routes: Record<string, StubReply>) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const reply = routes[req.url ?? ""] ?? { status: 404, body: { success: false } };
    res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const HEALTH = { status: "ok", uptimeSec: 720, version: "0.0.0", checks: { mongodb: "up" } };
export const ok = (data: unknown, correlationId = "srv-corr"): StubReply => ({
  status: 200,
  body: { success: true, data, meta: { correlationId } },
});
export const fail = (status: number, code: string, message: string, correlationId = "srv-corr"): StubReply => ({
  status,
  body: { success: false, error: { code, message, statusCode: status, correlationId } },
});
