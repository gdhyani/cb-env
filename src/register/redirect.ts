import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";

type Callback = (...args: unknown[]) => void;

export function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

const toArray = <T>(v: T | readonly T[]): T[] => (Array.isArray(v) ? [...v] : [v as T]);

/** tls.connect(options[, cb]) | tls.connect(port[, host][, options][, cb]) */
function normalizeTlsArgs(args: unknown[]): { options: tls.ConnectionOptions; callback?: Callback } {
  const a = [...args];
  const callback = typeof a[a.length - 1] === "function" ? (a.pop() as Callback) : undefined;
  if (typeof a[0] === "object" && a[0] !== null) return { options: { ...(a[0] as tls.ConnectionOptions) }, callback };
  const positional: tls.ConnectionOptions = { port: Number(a[0]) };
  let rest: unknown = a[1];
  if (typeof a[1] === "string") {
    positional.host = a[1];
    rest = a[2];
  }
  const extra = typeof rest === "object" && rest !== null ? (rest as tls.ConnectionOptions) : {};
  return { options: { ...extra, ...positional }, callback };
}

/** Socket#connect receives user args or Node's internal normalized [options, cb] array. */
function normalizeNetArgs(args: unknown[]): [net.TcpNetConnectOpts, Callback | undefined] | undefined {
  const a = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const [first, second, third] = a;
  if (typeof first === "object" && first !== null) {
    const o = first as net.NetConnectOpts;
    if ("path" in o && o.path) return undefined;
    return [o as net.TcpNetConnectOpts, typeof second === "function" ? (second as Callback) : undefined];
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const cb = [second, third].find((x) => typeof x === "function") as Callback | undefined;
    return [{ port: Number(first), host: typeof second === "string" ? second : undefined }, cb];
  }
  return undefined;
}

/**
 * FR-REG-003/004 (Layer 2): connections to redirected host:port go to the agent's local port.
 * TLS keeps verification on, with SNI = original host and the org CA trusted for this connection only (L13).
 */
export function installRedirects(redirects: Record<string, number>, orgCaCert: string): void {
  const table = new Map<string, number>();
  for (const [key, port] of Object.entries(redirects)) table.set(key.toLowerCase(), port);
  if (table.size === 0) return;
  const lookup = (host: string | undefined, port: number | string | undefined) =>
    host === undefined || port === undefined ? undefined : table.get(`${normalizeHost(host)}:${Number(port)}`);

  const originalTlsConnect = tls.connect;
  const connectTls = originalTlsConnect as (options: tls.ConnectionOptions, cb?: Callback) => tls.TLSSocket;
  // biome-ignore lint/suspicious/noExplicitAny: tls.connect is overloaded; arguments are forwarded verbatim.
  (tls as any).connect = function cbTlsConnect(...args: unknown[]) {
    const { options, callback } = normalizeTlsArgs(args);
    if (!options.socket && !options.path) {
      const host = options.host ?? "localhost";
      const local = lookup(host, options.port ?? 443);
      if (local !== undefined) {
        const original = normalizeHost(host);
        return connectTls.call(
          tls,
          {
            ...options,
            host: "127.0.0.1",
            port: local,
            servername: options.servername ?? (net.isIP(original) ? undefined : original),
            ca: [...(options.ca ? toArray(options.ca) : tls.rootCertificates), orgCaCert],
          },
          callback,
        );
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the original overloaded call.
    return (originalTlsConnect as any).apply(tls, args);
  };

  const originalSocketConnect = net.Socket.prototype.connect;
  const connectSocket = originalSocketConnect as (
    this: net.Socket,
    options: net.TcpNetConnectOpts,
    cb?: Callback,
  ) => net.Socket;
  // biome-ignore lint/suspicious/noExplicitAny: Socket#connect is overloaded; arguments are forwarded verbatim.
  (net.Socket.prototype as any).connect = function cbSocketConnect(this: net.Socket, ...args: unknown[]) {
    const normalized = normalizeNetArgs(args);
    if (normalized) {
      const [options, callback] = normalized;
      const local = lookup(options.host ?? "localhost", options.port);
      if (local !== undefined)
        return connectSocket.call(this, { ...options, host: "127.0.0.1", port: local }, callback);
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the original overloaded call.
    return (originalSocketConnect as any).apply(this, args);
  };

  // firebase-admin sends `:scheme: "https:"` (a URL.protocol). Google tolerates it, but nghttp2 servers — the
  // gateway included — reset the stream. Normalize it on redirected sessions only; the meaning is unchanged.
  const originalH2Connect = http2.connect;
  // biome-ignore lint/suspicious/noExplicitAny: http2.connect is overloaded; arguments are forwarded verbatim.
  (http2 as any).connect = function cbH2Connect(authority: string | URL, ...rest: unknown[]) {
    // biome-ignore lint/suspicious/noExplicitAny: forwarding the original overloaded call.
    const session = (originalH2Connect as any).call(http2, authority, ...rest) as http2.ClientHttp2Session;
    let url: URL | undefined;
    try {
      url = typeof authority === "string" ? new URL(authority) : authority;
    } catch {
      url = undefined;
    }
    if (url && lookup(url.hostname, url.port || 443) !== undefined) {
      const request = session.request;
      session.request = function cbH2Request(this: http2.ClientHttp2Session, headers, ...args) {
        const scheme =
          headers && !Array.isArray(headers) ? (headers as http2.OutgoingHttpHeaders)[":scheme"] : undefined;
        const fixed =
          typeof scheme === "string" && scheme.endsWith(":") ? { ...headers, ":scheme": scheme.slice(0, -1) } : headers;
        return request.call(this, fixed, ...args);
      } as typeof session.request;
    }
    return session;
  };
}
