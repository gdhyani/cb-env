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
  /** A current access token, fetched per connection (tokens are short-lived, FR-AUTH-004). */
  getToken: () => Promise<string>;
  onClose?: (code: number, reason: string) => void;
}

/** Thin agent (L4): one authenticated WebSocket per TCP connection, raw bytes both ways, no protocol logic. */
export async function pipeToTunnel(socket: net.Socket, url: string, opts: TunnelOptions): Promise<void> {
  // The app's first bytes wait in the (not yet piped) socket while the token is fetched.
  let token: string;
  try {
    token = await opts.getToken();
  } catch (err) {
    opts.onClose?.(4401, err instanceof Error ? err.message : "not logged in");
    socket.destroy();
    return;
  }
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}`, "x-cb-agent-version": AGENT_VERSION },
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
