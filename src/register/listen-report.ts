import fs from "node:fs";
import net from "node:net";

type Listen = (this: net.Server, ...args: unknown[]) => net.Server;

/** The port the call asked for: a number, a numeric string or `{ port }`; 0 / none = a random port. */
function requestedPort(args: unknown[]): number {
  const [first] = args;
  if (typeof first === "number") return first;
  if (typeof first === "string" && /^\d+$/.test(first)) return Number(first);
  if (first && typeof first === "object" && "port" in first) return Number((first as { port?: unknown }).port) || 0;
  return 0;
}

/**
 * FR-WH-003: tells `cb run` which ports this process listens on, so webhooks reach the app on whatever port it
 * really uses — no port setting, and a changed port needs nothing. One JSON line per listening server; never throws
 * into the app, never touches the network (FR-REG-002).
 */
export function installListenReport(file: string): void {
  const original = net.Server.prototype.listen as unknown as Listen;
  const patched: Listen = function (this: net.Server, ...args: unknown[]) {
    const explicit = requestedPort(args) > 0;
    this.once("listening", () => {
      try {
        const address = this.address();
        if (!address || typeof address === "string") return; // pipes and sockets carry no port
        // http/https servers have maxHeadersCount; HTTP/2 servers and any server with a request handler emit "request".
        const http = "maxHeadersCount" in this || this.listenerCount("request") > 0;
        fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, port: address.port, http, explicit })}\n`);
      } catch {
        // reporting is best effort; the app must never notice
      }
    });
    return original.apply(this, args);
  };
  net.Server.prototype.listen = patched as unknown as typeof net.Server.prototype.listen;
}
