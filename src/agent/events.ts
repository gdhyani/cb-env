import { CORRELATION_HEADER } from "../constants";

export type AgentEvent = { type: "config.changed" } | { type: "access.revoked"; reason: string } | { type: "ready" };

export interface EventSubscription {
  close(): void;
}

/** FR-AGT-006: SSE subscription with exponential backoff reconnects. */
export function subscribeAgentEvents(opts: {
  serverUrl: string;
  token: string;
  envId: string;
  correlationId: string;
  onEvent: (event: AgentEvent) => void;
  onError?: (message: string) => void;
}): EventSubscription {
  let closed = false;
  let controller: AbortController | undefined;
  let attempt = 0;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const url = new URL("/api/agent/events", opts.serverUrl);
        url.searchParams.set("envId", opts.envId);
        const res = await fetch(url, {
          headers: {
            authorization: `Bearer ${opts.token}`,
            accept: "text/event-stream",
            [CORRELATION_HEADER]: opts.correlationId,
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => undefined)) as
            | { error?: { code?: string; message?: string } }
            | undefined;
          if (body?.error?.code === "NO_ACCESS" || body?.error?.code === "ENVIRONMENT_KILLED") {
            opts.onEvent({ type: "access.revoked", reason: body.error.message ?? "access revoked" });
            return;
          }
          throw new Error(`events stream HTTP ${res.status}`);
        }
        attempt = 0;
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          let i = buffer.indexOf("\n\n");
          while (i >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (name === "config.changed") opts.onEvent({ type: "config.changed" });
            else if (name === "ready") opts.onEvent({ type: "ready" });
            else if (name === "access.revoked") {
              const parsed = data ? (JSON.parse(data) as { reason?: string }) : {};
              opts.onEvent({ type: "access.revoked", reason: parsed.reason ?? "access revoked" });
            }
            i = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (closed) return;
        opts.onError?.(err instanceof Error ? err.message : String(err));
      }
      if (closed) return;
      attempt += 1;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * 2 ** attempt)));
    }
  };
  void run();
  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}
