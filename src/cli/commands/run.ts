import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import spawn from "cross-spawn";
import { AGENT_HEALTH_MS, ENV, MSG } from "../../constants";
import { readSnapshotSync } from "../../register/snapshot";
import { type AgentConnection, ensureAgent, type SessionSummary } from "../../shared/agent-ipc";
import { requireServerCredentials } from "../../shared/credentials";
import { CbError } from "../../shared/errors";
import { requireProjectConfig } from "../../shared/project-config";
import type { Snapshot } from "../../shared/schemas";
import { loadState } from "../../shared/state";
import { note, resolveServer } from "../context";

export function quoteNodeOption(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function appendNodeOption(existing: string | undefined, option: string): string {
  if (!existing) return option;
  return existing.includes(option) ? existing : `${existing} ${option}`;
}

export function registerPath(): string {
  // dist/cli/commands/run.js → dist/register/index.js
  return path.resolve(__dirname, "..", "..", "register", "index.js");
}

/** FR-PKG-004: snapshot values win for managed keys; preload injected through NODE_OPTIONS. */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  snapshot: Snapshot,
  snapshotFile: string,
  register = registerPath(),
): NodeJS.ProcessEnv {
  return {
    ...parent,
    ...snapshot.env,
    [ENV.snapshot]: snapshotFile,
    NODE_OPTIONS: appendNodeOption(parent.NODE_OPTIONS, `--require ${quoteNodeOption(register)}`),
  };
}

/**
 * FR-WH-003: the port webhooks are delivered to — `--webhook-port`, then `.cb/project.json` webhookPort, then the
 * PORT the app will see (shell or cb variable). Undefined lets the service's default (or 3000) apply.
 */
export function resolveWebhookPort(
  flag: string | undefined,
  configured: number | undefined,
  childEnv: NodeJS.ProcessEnv,
): number | undefined {
  const valid = (v: unknown) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : undefined;
  };
  if (flag !== undefined) {
    const n = valid(flag);
    if (n === undefined) throw new CbError("BAD_FLAG", `cb run: --webhook-port must be a port number (got "${flag}")`);
    return n;
  }
  return configured ?? valid(childEnv.PORT);
}

export interface RunOptions {
  env?: string;
  webhookPort?: string;
  server?: string;
  restart?: boolean;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
}

export async function resolveEnvironmentName(
  projectId: string,
  flag: string | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (flag) return flag;
  const state = await loadState(env);
  return state.environments[projectId] ?? fallback;
}

/** Connects to the daemon (starting it if needed) and attaches this project environment. */
async function attach(
  env: NodeJS.ProcessEnv,
  request: { server: string; projectId: string; orgId?: string; environment: string; webhookPort?: number },
): Promise<{ conn: AgentConnection; snapshotFile: string; summary: SessionSummary }> {
  const conn = await ensureAgent(env);
  conn.send({ type: "attach", ...request });
  const reply = await conn.next("attached");
  if (reply.type === "error") {
    conn.close();
    throw new CbError(reply.code, reply.message);
  }
  return { conn, snapshotFile: reply.snapshotFile, summary: reply.session };
}

export async function runCommand(cmd: string[], opts: RunOptions = {}): Promise<number> {
  const parentEnv = opts.processEnv ?? process.env;
  const { config } = requireProjectConfig(opts.cwd);
  const server = resolveServer(opts.server, config.server);
  // Fail fast when logged out; the daemon reads the token itself and it never crosses IPC.
  await requireServerCredentials(server, parentEnv);
  const environment = await resolveEnvironmentName(config.projectId, opts.env, config.defaultEnvironment, parentEnv);
  const [file, ...args] = cmd;
  if (!file) throw new Error("cb run: missing command. Usage: cb run -- <command>");
  const base = { server, projectId: config.projectId, orgId: config.orgId, environment };
  // PORT may itself be a cb variable: the first attach writes the snapshot, then the final port is re-sent.
  const shellPort = resolveWebhookPort(opts.webhookPort, config.webhookPort, parentEnv);
  let { conn, snapshotFile, summary } = await attach(parentEnv, { ...base, webhookPort: shellPort });
  const webhookPort = resolveWebhookPort(opts.webhookPort, config.webhookPort, {
    ...parentEnv,
    ...readSnapshotSync(snapshotFile).env,
  });
  const request = { ...base, webhookPort };
  if (webhookPort !== shellPort) conn.send({ type: "attach", ...request });
  // J7: while access is revoked or stopped, refuse to start (the preload would fail closed anyway).
  if (summary.revoked) {
    const reason = readSnapshotSync(snapshotFile).revokedReason ?? "access revoked";
    conn.close();
    throw new CbError("ACCESS_REVOKED", MSG.revoked(reason));
  }
  note(
    `cb: ${config.projectSlug ?? config.projectId} / ${environment} — ${summary.listeners} brokered connection(s), ${summary.redirects} redirected host(s)`,
  );

  let child: ChildProcess | undefined;
  let restartRequested = false;
  let revoked = false;
  let finished = false;

  const restart = (message: string) => {
    note(message);
    if (opts.restart === false) return;
    restartRequested = true;
    child?.kill("SIGTERM");
  };
  // FR-PKG-005: the daemon refreshes the snapshot; this process restarts the app and prints banners.
  const listen = (c: AgentConnection) =>
    c.onMessage((m) => {
      if (m.type === "config.changed") restart("cb: configuration changed — restarting your app");
      else if (m.type === "access.restored" && revoked) {
        revoked = false;
        restart("cb: access restored — reconnecting your app");
      } else if (m.type === "access.revoked" && !revoked) {
        revoked = true;
        note(`\n${"!".repeat(72)}\n${MSG.revoked(m.reason)}\n${"!".repeat(72)}\n`);
      } else if (m.type === "notice") note(m.message);
    });
  listen(conn);

  // FR-AGT-007: check the daemon every few seconds and respawn it (same ports, from state.json) if it is gone.
  let reconnecting = false;
  const health = setInterval(async () => {
    if (finished || reconnecting || !conn.socket.destroyed) return;
    reconnecting = true;
    try {
      ({ conn, snapshotFile } = await attach(parentEnv, request));
      listen(conn);
      note("cb: background agent restarted");
    } catch (err) {
      note(`cb: background agent unavailable — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reconnecting = false;
    }
  }, AGENT_HEALTH_MS);

  const onSigint = () => undefined; // the terminal delivers Ctrl+C to the child directly
  const forward = (signal: NodeJS.Signals) => () => child?.kill(signal);
  const onSigterm = forward("SIGTERM");
  const onSighup = forward("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    for (;;) {
      const snapshot = readSnapshotSync(snapshotFile);
      child = spawn(file, args, {
        stdio: "inherit",
        cwd: opts.cwd,
        env: buildChildEnv(parentEnv, snapshot, snapshotFile),
      });
      const code = await new Promise<number>((resolve, reject) => {
        child?.on("error", reject);
        child?.on("exit", (c, signal) => resolve(c ?? 128 + (signal ? (os.constants.signals[signal] ?? 0) : 0)));
      });
      if (restartRequested) {
        restartRequested = false;
        continue;
      }
      return code;
    }
  } finally {
    finished = true;
    clearInterval(health);
    conn.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
  }
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a command with cb-managed env and brokered connections")
    .option("--env <name>", "environment (default: project default or `cb env use`)")
    .option("--server <url>", "backend URL")
    .option("--no-restart", "do not restart the app when configuration changes")
    .option("--webhook-port <port>", "port your app listens on for webhooks cb delivers (default: PORT, then 3000)")
    .argument("<cmd...>", "command to run, after --")
    .passThroughOptions()
    .action(async (cmd: string[], opts: { env?: string; server?: string; restart: boolean; webhookPort?: string }) => {
      const code = await runCommand(cmd, opts);
      // Mirror the child's exit immediately; lingering keep-alive or stream handles must not keep cb alive.
      process.exit(code);
    });
}
