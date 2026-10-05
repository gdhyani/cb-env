import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocketServer } from "ws";
import { Agent } from "../../src/agent/agent";
import type { Bootstrap } from "../../src/shared/schemas";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

async function stubBackend(boot: () => Bootstrap) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: boot(), meta: { correlationId: "c" } }));
  });
  new WebSocketServer({ server }).on("connection", (ws) => {
    const s = createWebSocketStream(ws);
    s.pipe(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("agent refresh (FR-AGT-006, J6)", () => {
  it("J6 refreshing with an open app connection completes, keeps the port and the connection", async () => {
    let appName = "before";
    const boot = (): Bootstrap => ({
      schema: 1,
      version: 1,
      orgId: "o",
      projectId: "p",
      projectSlug: "p",
      environment: "development",
      envId: "e",
      orgCaCert: "",
      plain: { APP_NAME: appName },
      listeners: [{ resourceId: "r1", kind: "redis", name: "cache", env: { REDIS_URL: "redis://127.0.0.1:{port}" } }],
      redirects: [],
      visibleKeys: [],
      files: {},
    });
    const serverUrl = await stubBackend(boot);
    const agent = new Agent({
      serverUrl,
      getToken: async () => "t",
      projectId: "p",
      environment: "development",
      correlationId: "c",
      env: { CB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cb-refresh-")) },
      portRange: { min: 7860, max: 7869 },
    });
    const first = await agent.start();
    const port = Number(new URL(first.env.REDIS_URL ?? "").port);

    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    const echo = (msg: string) =>
      new Promise<string>((resolve) => {
        socket.once("data", (d) => resolve(d.toString()));
        socket.write(msg);
      });
    expect(await echo("one")).toBe("one");

    appName = "after";
    const refreshed = await Promise.race([
      agent.start(),
      new Promise<never>((_, j) => setTimeout(() => j(new Error("refresh hung")), 3000)),
    ]);
    expect(refreshed.env.APP_NAME).toBe("after");
    expect(refreshed.env.REDIS_URL).toBe(first.env.REDIS_URL);
    expect(await echo("two")).toBe("two");
    socket.destroy();
    await agent.stop();
  });
});
