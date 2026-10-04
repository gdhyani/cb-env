import { MSG } from "../constants";
import { CbError } from "../shared/errors";
import { writeJsonAtomic } from "../shared/files";
import { createBackendClient } from "../shared/http";
import { snapshotPath } from "../shared/paths";
import { type Bootstrap, BootstrapSchema, type Snapshot } from "../shared/schemas";
import { loadState, saveState } from "../shared/state";
import { type LocalListener, listenLocal } from "./listeners";
import { allocatePorts } from "./ports";
import { listenerKey, redirectKey, renderSnapshot } from "./snapshot";
import { pipeToTunnel, tunnelUrl } from "./tunnel";

export interface AgentOptions {
  serverUrl: string;
  /** Current access token (refreshed as needed). */
  getToken: () => Promise<string>;
  projectId: string;
  orgId?: string;
  environment: string;
  correlationId: string;
  env?: NodeJS.ProcessEnv;
  portRange?: { min: number; max: number };
  log?: (message: string) => void;
}

export async function fetchBootstrap(o: AgentOptions): Promise<Bootstrap> {
  const client = createBackendClient({
    serverUrl: o.serverUrl,
    token: await o.getToken(),
    correlationId: o.correlationId,
  });
  const q = new URLSearchParams({ projectId: o.projectId, env: o.environment, ...(o.orgId ? { orgId: o.orgId } : {}) });
  try {
    return await client.get(`/api/agent/bootstrap?${q.toString()}`, BootstrapSchema);
  } catch (err) {
    if (err instanceof CbError && err.code === "NO_ACCESS")
      throw new CbError("NO_ACCESS", MSG.noAccess(o.environment), { correlationId: err.correlationId });
    throw err;
  }
}

/** Listeners, tunnels and the snapshot for one project environment (hosted by the daemon, FR-AGT-003). */
export class Agent {
  readonly opts: AgentOptions;
  snapshot: Snapshot | undefined;
  bootstrap: Bootstrap | undefined;
  readonly snapshotFile: string;
  /** Listeners by key ("l1:<resource>" / "l2:<host>:<port>"), reused across refreshes. */
  #listeners = new Map<string, LocalListener>();
  #tunnels = 0;

  /** Open app connections (each is one tunnel); the daemon stays alive while any exist (FR-AGT-007). */
  get tunnels(): number {
    return this.#tunnels;
  }

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.snapshotFile = snapshotPath(opts.projectId, opts.environment, opts.env ?? process.env);
  }

  /** Bootstrap (or refresh): allocate stable ports, reconcile listeners, write the snapshot. */
  async start(): Promise<Snapshot> {
    const b = await fetchBootstrap(this.opts);
    const env = this.opts.env ?? process.env;
    const scope = `${b.projectId}/${b.environment}/`;
    const wanted = new Map<string, { url: string; label: string }>();
    for (const l of b.listeners) {
      wanted.set(listenerKey(l.resourceId), {
        url: tunnelUrl(this.opts.serverUrl, { layer: "1", env: b.envId, resource: l.resourceId }),
        label: `${l.kind} "${l.name}"`,
      });
    }
    for (const r of b.redirects) {
      wanted.set(redirectKey(r.host, r.port), {
        url: tunnelUrl(this.opts.serverUrl, { layer: "2", env: b.envId, host: r.host, port: String(r.port) }),
        label: r.host,
      });
    }

    // Drop listeners that are no longer needed; keep the rest so live connections survive a refresh.
    for (const [key, listener] of this.#listeners) {
      if (!wanted.has(key)) {
        listener.close();
        this.#listeners.delete(key);
      }
    }
    const state = await loadState(env);
    const current = Object.fromEntries([...this.#listeners].map(([k, l]) => [scope + k, l.port]));
    state.ports = await allocatePorts(
      [...wanted.keys()].filter((k) => !this.#listeners.has(k)).map((k) => scope + k),
      { ...state.ports, ...current },
      this.opts.portRange,
    );
    await saveState(state, env);
    const portOf = (key: string) => {
      const port = this.#listeners.get(key)?.port ?? state.ports[scope + key];
      if (port === undefined) throw new Error(`agent: no port for ${key}`);
      return port;
    };

    const onClose = (what: string) => (code: number, reason: string) => {
      if (code === 4401) this.opts.log?.(`cb: ${what}: session expired or device revoked. Run "npx cb login".`);
      else if (code === 4403) this.opts.log?.(`cb: ${what}: ${reason || "no access"}`);
      else if (code === 4410) this.opts.log?.(`cb: ${what}: ${reason || "access revoked"}`);
      else if (code === 4502) this.opts.log?.(`cb: ${what}: upstream error — ${reason}`);
    };
    for (const [key, { url, label }] of wanted) {
      if (this.#listeners.has(key)) continue;
      this.#listeners.set(
        key,
        await listenLocal(portOf(key), (s) => {
          this.#tunnels += 1;
          s.once("close", () => {
            this.#tunnels -= 1;
          });
          void pipeToTunnel(s, url, { getToken: this.opts.getToken, onClose: onClose(label) });
        }),
      );
    }
    this.bootstrap = b;
    this.snapshot = renderSnapshot(b, portOf);
    await writeJsonAtomic(this.snapshotFile, this.snapshot);
    return this.snapshot;
  }

  /** FR-AGT-006: on revocation, mark the snapshot revoked (preload fails closed) and stop listening. */
  async revoke(reason: string): Promise<void> {
    await this.closeListeners();
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, status: "revoked", revokedReason: reason };
      await writeJsonAtomic(this.snapshotFile, this.snapshot);
    }
  }

  async closeListeners(): Promise<void> {
    for (const listener of this.#listeners.values()) listener.close();
    this.#listeners.clear();
  }

  async stop(): Promise<void> {
    await this.closeListeners();
  }
}
