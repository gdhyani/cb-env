import type net from "node:net";
import { z } from "zod";
import { ENV, EVENTS_BACKOFF_BASE_MS, EVENTS_BACKOFF_MAX_MS, EVENTS_IDLE_MS, RESTART_DEBOUNCE_MS } from "../constants";
import { type AgentMessage, type SessionSummary, writeLine } from "../shared/agent-ipc";
import { newCorrelationId } from "../shared/correlation";
import { requireServerCredentials } from "../shared/credentials";
import { createBackendClient } from "../shared/http";
import { getAccessToken } from "../shared/token";
import { Agent } from "./agent";
import { type EventSubscription, subscribeAgentEvents } from "./events";
import { createWebhookDeliverer } from "./webhooks";

export interface SessionKey {
  server: string;
  projectId: string;
  orgId?: string;
  environment: string;
}

export const sessionId = (k: SessionKey) => `${k.server.replace(/\/+$/, "")}|${k.projectId}|${k.environment}`;

/**
 * One project environment inside the daemon: the agent (listeners, tunnels, snapshot), its SSE subscription,
 * and the `cb run` clients attached to it. FR-AGT-006: refreshes on config.changed, marks the snapshot revoked
 * on revocation and restores it on re-grant, notifying every client.
 */
export class Session {
  readonly key: SessionKey;
  readonly clients = new Set<net.Socket>();
  /** Webhook port each attached `cb run` named, in attach order (the latest run wins). */
  readonly #ports = new Map<net.Socket, number | undefined>();
  #webhooks: ReturnType<typeof createWebhookDeliverer> | undefined;
  agent: Agent | undefined;
  revoked = false;
  #events: EventSubscription | undefined;
  #timer: NodeJS.Timeout | undefined;
  readonly #env: NodeJS.ProcessEnv;
  readonly #log: (line: string) => void;

  constructor(key: SessionKey, env: NodeJS.ProcessEnv, log: (line: string) => void) {
    this.key = key;
    this.#env = env;
    this.#log = log;
  }

  /** First bootstrap; throws (e.g. NO_ACCESS, NOT_LOGGED_IN) so the attaching client gets a clear error. */
  async start(): Promise<void> {
    if (this.agent?.snapshot) return;
    // The device token is read here from the keychain/credential store; it never crosses the IPC socket.
    await requireServerCredentials(this.key.server, this.#env);
    const getToken = () => getAccessToken(this.key.server, this.#env);
    this.agent = new Agent({
      serverUrl: this.key.server,
      getToken,
      projectId: this.key.projectId,
      orgId: this.key.orgId,
      environment: this.key.environment,
      correlationId: newCorrelationId(),
      env: this.#env,
      log: (message) => this.broadcast({ type: "notice", message }),
    });
    await this.agent.start();
    this.#webhooks = createWebhookDeliverer({
      appPort: () => {
        const ports = [...this.#ports.values()];
        return { attached: ports.length > 0, port: ports.reverse().find((p) => p !== undefined) };
      },
      ack: async (deliveryId, body) => {
        const client = createBackendClient({
          serverUrl: this.key.server,
          token: await getToken(),
          correlationId: this.agent?.opts.correlationId,
        });
        await client.post(`/api/agent/webhooks/${encodeURIComponent(deliveryId)}/ack`, body, z.unknown());
      },
      notify: (message) => {
        this.#log(`session ${this.label}: ${message.replace(/^cb: /, "")}`);
        this.broadcast({ type: "notice", message });
      },
    });
    this.#subscribe();
  }

  attach(socket: net.Socket, webhookPort?: number) {
    const first = !this.#ports.has(socket);
    this.clients.add(socket);
    this.#ports.delete(socket);
    this.#ports.set(socket, webhookPort);
    // FR-WH-003: an app just started under cb — webhooks that waited for it go out now, not at the next retry.
    if (first) void this.#redeliver();
  }

  async #redeliver() {
    try {
      const client = createBackendClient({
        serverUrl: this.key.server,
        token: await getAccessToken(this.key.server, this.#env),
        correlationId: this.agent?.opts.correlationId,
      });
      await client.post(
        "/api/agent/webhooks/redeliver",
        { projectId: this.key.projectId, orgId: this.key.orgId, env: this.key.environment },
        z.unknown(),
      );
    } catch (err) {
      this.#log(
        `session ${this.label}: webhook redelivery request failed — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  detach(socket: net.Socket) {
    this.clients.delete(socket);
    this.#ports.delete(socket);
  }

  #subscribe() {
    this.#events?.close();
    this.#events = subscribeAgentEvents({
      serverUrl: this.key.server,
      getToken: (rejected) => getAccessToken(this.key.server, this.#env, rejected),
      idleMs: Number(this.#env[ENV.eventsIdleMs] ?? EVENTS_IDLE_MS),
      tickMs: Math.min(5_000, Math.max(50, Number(this.#env[ENV.eventsIdleMs] ?? EVENTS_IDLE_MS) / 4)),
      backoff: {
        baseMs: EVENTS_BACKOFF_BASE_MS,
        maxMs: Number(this.#env[ENV.eventsBackoffMaxMs] ?? EVENTS_BACKOFF_MAX_MS),
      },
      envId: this.agent?.bootstrap?.envId ?? "",
      correlationId: this.agent?.opts.correlationId ?? newCorrelationId(),
      onEvent: (event) => {
        if (event.type === "webhook") {
          void this.#webhooks?.deliver(event.push);
          return;
        }
        // "ready" = the stream (re)connected: re-check, since changes made while it was down were not pushed.
        if (event.type === "config.changed" || event.type === "ready") this.#scheduleRefresh();
        if (event.type === "access.revoked" && !this.revoked) {
          this.revoked = true;
          this.#log(`session ${this.label}: access revoked (${event.reason})`);
          // Notify only once the snapshot says "revoked", so an app restarted on this event fails closed.
          void Promise.resolve(this.agent?.revoke(event.reason)).finally(() =>
            this.broadcast({ type: "access.revoked", reason: event.reason }),
          );
        }
      },
      onError: (message) => this.#log(`session ${this.label}: events stream — ${message}`),
      onAuthLost: (message) => {
        this.#log(`session ${this.label}: signed out — ${message}`);
        this.broadcast({
          type: "notice",
          message: `cb: this device is signed out (${message}). Run "cb login" — your app keeps running and cb reconnects by itself.`,
        });
      },
    });
  }

  #scheduleRefresh() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(async () => {
      const agent = this.agent;
      if (!agent) return;
      const wasRevoked = this.revoked;
      try {
        const before = JSON.stringify(agent.snapshot?.env);
        await agent.start();
        this.revoked = false;
        if (wasRevoked) {
          this.#log(`session ${this.label}: access restored`);
          this.broadcast({ type: "access.restored" });
        } else if (JSON.stringify(agent.snapshot?.env) !== before) {
          this.broadcast({ type: "config.changed" });
        }
      } catch (err) {
        // Still revoked (or backend unreachable): stay as is; the next event retries.
        if (!wasRevoked)
          this.#log(`session ${this.label}: refresh failed — ${err instanceof Error ? err.message : err}`);
      }
    }, RESTART_DEBOUNCE_MS);
  }

  get label(): string {
    return `${this.agent?.bootstrap?.projectSlug ?? this.key.projectId}/${this.key.environment}`;
  }

  summary(): SessionSummary {
    return {
      projectId: this.key.projectId,
      projectSlug: this.agent?.bootstrap?.projectSlug,
      environment: this.key.environment,
      listeners: this.agent?.bootstrap?.listeners.length ?? 0,
      redirects: this.agent?.bootstrap?.redirects.length ?? 0,
      clients: this.clients.size,
      tunnels: this.agent?.tunnels ?? 0,
      revoked: this.revoked,
    };
  }

  broadcast(message: AgentMessage) {
    for (const client of this.clients) writeLine(client, message);
  }

  /** Message for a client attaching while access is revoked. */
  revokedMessage(): AgentMessage {
    return { type: "access.revoked", reason: this.agent?.snapshot?.revokedReason ?? "access revoked" };
  }

  async stop(): Promise<void> {
    clearTimeout(this.#timer);
    this.#events?.close();
    await this.agent?.stop();
  }
}
