import type net from "node:net";
import { MSG } from "../constants";
import { CbError } from "../shared/errors";
import { writeJsonAtomic } from "../shared/files";
import { createBackendClient } from "../shared/http";
import { snapshotPath } from "../shared/paths";
import { type Bootstrap, BootstrapSchema, type Snapshot } from "../shared/schemas";
import { loadState, saveState } from "../shared/state";
import { closeServer, listenLocal } from "./listeners";
import { allocatePorts } from "./ports";
import { listenerKey, redirectKey, renderSnapshot } from "./snapshot";
import { pipeToTunnel, tunnelUrl } from "./tunnel";

export interface AgentOptions {
  serverUrl: string;
  token: string;
  projectId: string;
  orgId?: string;
  environment: string;
  correlationId: string;
  env?: NodeJS.ProcessEnv;
  portRange?: { min: number; max: number };
  log?: (message: string) => void;
}

export async function fetchBootstrap(o: AgentOptions): Promise<Bootstrap> {
  const client = createBackendClient({ serverUrl: o.serverUrl, token: o.token, correlationId: o.correlationId });
  const q = new URLSearchParams({ projectId: o.projectId, env: o.environment, ...(o.orgId ? { orgId: o.orgId } : {}) });
  try {
    return await client.get(`/api/agent/bootstrap?${q.toString()}`, BootstrapSchema);
  } catch (err) {
    if (err instanceof CbError && err.code === "UNAUTHORIZED") throw new CbError("NOT_LOGGED_IN", MSG.notLoggedIn);
    if (err instanceof CbError && err.code === "NO_ACCESS")
      throw new CbError("NO_ACCESS", MSG.noAccess(o.environment), { correlationId: err.correlationId });
    throw err;
  }
}

/** In-process agent (M0-D5): listeners, tunnels and the snapshot for one project environment. */
export class Agent {
  readonly opts: AgentOptions;
  snapshot: Snapshot | undefined;
  bootstrap: Bootstrap | undefined;
  readonly snapshotFile: string;
  #servers: net.Server[] = [];

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.snapshotFile = snapshotPath(opts.projectId, opts.environment, opts.env ?? process.env);
  }

  /** Bootstrap (or refresh): allocate stable ports, (re)open listeners, write the snapshot. */
  async start(): Promise<Snapshot> {
    const b = await fetchBootstrap(this.opts);
    const env = this.opts.env ?? process.env;
    const scope = `${b.projectId}/${b.environment}/`;
    const keys = [
      ...b.listeners.map((l) => listenerKey(l.resourceId)),
      ...b.redirects.map((r) => redirectKey(r.host, r.port)),
    ];
    await this.closeListeners();
    const state = await loadState(env);
    state.ports = await allocatePorts(
      keys.map((k) => scope + k),
      state.ports,
      this.opts.portRange,
    );
    await saveState(state, env);
    const portOf = (key: string) => {
      const port = state.ports[scope + key];
      if (port === undefined) throw new Error(`agent: no port for ${key}`);
      return port;
    };

    const onClose = (what: string) => (code: number, reason: string) => {
      if (code === 4401) this.opts.log?.(`cb: ${what}: session expired or device revoked. Run "npx cb login".`);
      else if (code === 4403) this.opts.log?.(`cb: ${what}: ${reason || "no access"}`);
      else if (code === 4410) this.opts.log?.(`cb: ${what}: ${reason || "access revoked"}`);
      else if (code === 4502) this.opts.log?.(`cb: ${what}: upstream error — ${reason}`);
    };
    for (const l of b.listeners) {
      const url = tunnelUrl(this.opts.serverUrl, { layer: "1", env: b.envId, resource: l.resourceId });
      this.#servers.push(
        await listenLocal(portOf(listenerKey(l.resourceId)), (s) =>
          pipeToTunnel(s, url, { token: this.opts.token, onClose: onClose(`${l.kind} "${l.name}"`) }),
        ),
      );
    }
    for (const r of b.redirects) {
      const url = tunnelUrl(this.opts.serverUrl, { layer: "2", env: b.envId, host: r.host, port: String(r.port) });
      this.#servers.push(
        await listenLocal(portOf(redirectKey(r.host, r.port)), (s) =>
          pipeToTunnel(s, url, { token: this.opts.token, onClose: onClose(r.host) }),
        ),
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
    const servers = this.#servers;
    this.#servers = [];
    await Promise.all(servers.map(closeServer));
  }

  async stop(): Promise<void> {
    await this.closeListeners();
  }
}
