import { z } from "zod";
import {
  CORRELATION_HEADER,
  EVENTS_BACKOFF_BASE_MS,
  EVENTS_BACKOFF_MAX_MS,
  EVENTS_IDLE_MS,
  EVENTS_TICK_MS,
  EVENTS_WAKE_GAP_MS,
} from "../constants";

/** FR-WH-003: one webhook delivery pushed by the backend (headers already signed with this device's fake). */
export const WebhookPushSchema = z.object({
  deliveryId: z.string().min(1),
  /** Bumped by a dashboard Replay: each generation is posted to the app once. */
  generation: z.number().int().min(0).default(0),
  eventId: z.string(),
  provider: z.enum(["stripe", "razorpay"]),
  type: z.string(),
  path: z.string().startsWith("/"),
  port: z.number().int().min(1).max(65_535).nullable(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
export type WebhookPush = z.infer<typeof WebhookPushSchema>;

export type AgentEvent =
  | { type: "config.changed" }
  | { type: "access.revoked"; reason: string }
  | { type: "ready" }
  | { type: "webhook"; push: WebhookPush };

export interface EventSubscription {
  close(): void;
}

const isLoginGone = (err: unknown) => (err as { code?: string } | undefined)?.code === "NOT_LOGGED_IN";

/**
 * FR-AGT-006: SSE subscription meant to stay up for days. Reconnects with jittered backoff; treats a silent
 * stream (no heartbeat within `idleMs`) and a timer gap (laptop slept, network changed) as dead connections;
 * fetches a fresh token per connect and a new one on 401; keeps retrying after the login is gone so a later
 * `cb login` recovers without restarting anything.
 */
export function subscribeAgentEvents(opts: {
  serverUrl: string;
  /** Fetched on every (re)connect: access tokens are short-lived. `rejected` = the token the server refused. */
  getToken: (rejected?: string) => Promise<string>;
  envId: string;
  correlationId: string;
  onEvent: (event: AgentEvent) => void;
  onError?: (message: string) => void;
  /** The device is signed out (refresh token gone); reported once per outage. */
  onAuthLost?: (message: string) => void;
  idleMs?: number;
  tickMs?: number;
  wakeGapMs?: number;
  backoff?: { baseMs: number; maxMs: number };
}): EventSubscription {
  const idleMs = opts.idleMs ?? EVENTS_IDLE_MS;
  const tickMs = opts.tickMs ?? EVENTS_TICK_MS;
  const wakeGapMs = opts.wakeGapMs ?? EVENTS_WAKE_GAP_MS;
  const backoff = opts.backoff ?? { baseMs: EVENTS_BACKOFF_BASE_MS, maxMs: EVENTS_BACKOFF_MAX_MS };
  let closed = false;
  let controller: AbortController | undefined;
  let attempt = 0;
  let lastByte = Date.now();
  let lastTick = Date.now();
  let authLost = false;
  let rejected: string | undefined;
  let wake: (() => void) | undefined;

  // One timer watches both: no bytes for idleMs → dead stream; a tick far later than scheduled → we slept.
  const watchdog = setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > wakeGapMs;
    lastTick = now;
    if (slept) {
      controller?.abort(new Error("resumed after sleep"));
      wake?.();
    } else if (now - lastByte > idleMs) controller?.abort(new Error(`no data for ${Math.round(idleMs / 1000)} s`));
  }, tickMs);
  watchdog.unref?.();

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  const dispatch = (name: string | undefined, data: string | undefined) => {
    if (name === "config.changed") opts.onEvent({ type: "config.changed" });
    else if (name === "ready") opts.onEvent({ type: "ready" });
    else if (name === "access.revoked") {
      let reason = "access revoked";
      try {
        reason = (JSON.parse(data ?? "{}") as { reason?: string }).reason ?? reason;
      } catch {
        // keep the generic reason
      }
      opts.onEvent({ type: "access.revoked", reason });
    } else if (name === "webhook") {
      let raw: unknown;
      try {
        raw = JSON.parse(data ?? "");
      } catch {
        opts.onError?.("ignored a malformed webhook event");
        return;
      }
      const parsed = WebhookPushSchema.safeParse(raw);
      if (parsed.success) opts.onEvent({ type: "webhook", push: parsed.data });
      else opts.onError?.("ignored a malformed webhook event");
    }
  };

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      let waitMs: number | undefined;
      try {
        const url = new URL("/api/agent/events", opts.serverUrl);
        url.searchParams.set("envId", opts.envId);
        const token = await opts.getToken(rejected);
        rejected = undefined;
        if (authLost) {
          authLost = false;
          opts.onError?.("signed in again; event stream resuming");
        }
        lastByte = Date.now();
        const res = await fetch(url, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "text/event-stream",
            [CORRELATION_HEADER]: opts.correlationId,
          },
          signal: controller.signal,
        });
        if (res.status === 401 && attempt === 0) {
          // Expired or rotated token: get a new one and retry at once (once; then normal backoff).
          await res.body?.cancel().catch(() => undefined);
          rejected = token;
          attempt += 1;
          continue;
        }
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => undefined)) as
            | { error?: { code?: string; message?: string } }
            | undefined;
          // Access refused at connect time: no grant, suspended environment or an active kill switch.
          if (["NO_ACCESS", "ENVIRONMENT_KILLED", "KILLSWITCH_ACTIVE"].includes(body?.error?.code ?? "")) {
            opts.onEvent({ type: "access.revoked", reason: body?.error?.message ?? "access revoked" });
            return;
          }
          if (res.status === 401) rejected = token;
          throw new Error(`events stream HTTP ${res.status}`);
        }
        const decoder = new TextDecoder();
        let buffer = "";
        let connected = false;
        for await (const chunk of res.body) {
          lastByte = Date.now();
          buffer += decoder.decode(chunk as Uint8Array, { stream: true }).replace(/\r\n/g, "\n");
          let i = buffer.indexOf("\n\n");
          while (i >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const name = /^event: ?(.+)$/m.exec(block)?.[1];
            const data = [...block.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join("\n") || undefined;
            if (name === "ready" && !connected) {
              connected = true;
              attempt = 0;
            }
            dispatch(name, data);
            i = buffer.indexOf("\n\n");
          }
        }
        if (!closed) opts.onError?.("events stream ended by the server; reconnecting");
      } catch (err) {
        if (closed) return;
        if (isLoginGone(err)) {
          if (!authLost) {
            authLost = true;
            opts.onAuthLost?.(err instanceof Error ? err.message : String(err));
          }
          waitMs = backoff.maxMs; // signed out: retry slowly until `cb login` puts a new token in place
        } else {
          const reason = controller.signal.aborted ? controller.signal.reason : err;
          opts.onError?.(reason instanceof Error ? reason.message : String(reason));
        }
      }
      if (closed) return;
      attempt += 1;
      const exp = Math.min(backoff.maxMs, backoff.baseMs * 2 ** attempt);
      // Jitter spreads reconnects when a backend restart drops every agent at once.
      await pause(waitMs ?? exp * (0.5 + Math.random() * 0.5));
    }
  };
  void run();
  return {
    close() {
      closed = true;
      clearInterval(watchdog);
      controller?.abort();
      wake?.();
    },
  };
}
