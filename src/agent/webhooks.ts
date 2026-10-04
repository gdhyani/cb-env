import { WEBHOOK_APP_TIMEOUT_MS, WEBHOOK_DEDUPE_SIZE, WEBHOOK_DEFAULT_PORT } from "../constants";
import type { WebhookPush } from "./events";

export type { WebhookPush } from "./events";

export interface AckBody {
  ok: boolean;
  status?: number;
  error?: string;
  ms?: number;
  /** Which push this answers (replays bump it). */
  generation?: number;
  /** No app runs under cb here: the backend waits instead of counting a failed attempt. */
  noApp?: boolean;
}

/**
 * FR-WH-003: hands a pushed webhook to the developer's app on 127.0.0.1 and reports the outcome. The agent stays a
 * pipe (L4): body bytes and headers are forwarded unchanged — the backend already re-signed them with this
 * device's fake; nothing here parses, verifies or signs.
 */
export function createWebhookDeliverer(opts: {
  /** Which app port the attached `cb run` named; attached=false when no app is running under cb. */
  appPort: () => { attached: boolean; port?: number };
  ack: (deliveryId: string, body: AckBody) => Promise<void>;
  notify: (message: string) => void;
  timeoutMs?: number;
}) {
  // deliveryId → result: a re-push (lost ack, reconnect) is re-acked without posting to the app again.
  const done = new Map<string, AckBody>();
  const inFlight = new Map<string, Promise<void>>();
  const remember = (id: string, result: AckBody) => {
    done.set(id, result);
    if (done.size > WEBHOOK_DEDUPE_SIZE) done.delete(done.keys().next().value as string);
  };

  async function post(push: WebhookPush): Promise<AckBody> {
    const app = opts.appPort();
    if (!app.attached && !push.port)
      return { ok: false, noApp: true, error: "app not running under cb run on this machine; sent when it starts" };
    const port = app.port ?? push.port ?? WEBHOOK_DEFAULT_PORT;
    // Built from parts, never resolved against a base: the host is always 127.0.0.1.
    let url: URL;
    try {
      url = new URL(`http://127.0.0.1:${port}${push.path}`);
      if (url.hostname !== "127.0.0.1" || url.port !== String(port)) throw new Error("not a local path");
    } catch {
      return { ok: false, error: `webhook path ${push.path} is not a path in your app` };
    }
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: push.headers,
        body: Buffer.from(push.body, "base64"),
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? WEBHOOK_APP_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      const ms = Date.now() - started;
      const ok = res.status >= 200 && res.status < 300;
      return ok ? { ok, status: res.status, ms } : { ok, status: res.status, ms, error: `app answered ${res.status}` };
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      const why =
        code === "ECONNREFUSED"
          ? `nothing is listening on 127.0.0.1:${port}`
          : (err as Error).name === "TimeoutError"
            ? `app did not answer within ${Math.round((opts.timeoutMs ?? WEBHOOK_APP_TIMEOUT_MS) / 1000)} s`
            : `could not reach 127.0.0.1:${port} (${code ?? (err as Error).message})`;
      return { ok: false, error: why, ms: Date.now() - started };
    }
  }

  async function deliver(push: WebhookPush): Promise<void> {
    const key = `${push.deliveryId}:${push.generation}`;
    const known = done.get(key);
    if (known?.ok) return opts.ack(push.deliveryId, { ...known, generation: push.generation }).catch(() => undefined);
    const running = inFlight.get(key);
    if (running) return running;
    const task = (async () => {
      const result = { ...(await post(push)), generation: push.generation };
      remember(key, result);
      const label = `webhook ${push.provider} ${push.type || push.eventId}`;
      opts.notify(
        result.ok
          ? `cb: ${label} → ${result.status} (${result.ms} ms)`
          : `cb: ${label} not delivered — ${result.error}${result.status ? "" : "; cb retries"}`,
      );
      await opts.ack(push.deliveryId, result).catch(() => undefined);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  }

  return { deliver };
}
