import type net from "node:net";
import { createWebSocketStream, WebSocket } from "ws";
import { AGENT_VERSION } from "../constants";

export function tunnelUrl(serverUrl: string, params: Record<string, string>): string {
  const url = new URL("/tunnel", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export interface TunnelOptions {
  token: string;
  onClose?: (code: number, reason: string) => void;
}

/** Thin agent (L4): one authenticated WebSocket per TCP connection, raw bytes both ways, no protocol logic. */
export function pipeToTunnel(socket: net.Socket, url: string, opts: TunnelOptions): void {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${opts.token}`, "x-cb-agent-version": AGENT_VERSION },
    perMessageDeflate: false,
  });
  const stream = createWebSocketStream(ws);
  const destroyBoth = () => {
    socket.destroy();
    stream.destroy();
  };
  ws.on("close", (code, reason) => {
    opts.onClose?.(code, reason.toString());
    socket.end();
  });
  socket.on("error", destroyBoth);
  stream.on("error", destroyBoth);
  socket.pipe(stream);
  stream.pipe(socket);
}
