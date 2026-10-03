import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import spawn from "cross-spawn";
import { Agent } from "../../agent/agent";
import { subscribeAgentEvents } from "../../agent/events";
import { ENV, MSG, RESTART_DEBOUNCE_MS } from "../../constants";
import { newCorrelationId } from "../../shared/correlation";
import { requireServerCredentials } from "../../shared/credentials";
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

export interface RunOptions {
  env?: string;
  server?: string;
  restart?: boolean;
  cwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  portRange?: { min: number; max: number };
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

export async function runCommand(cmd: string[], opts: RunOptions = {}): Promise<number> {
  const parentEnv = opts.processEnv ?? process.env;
  const { config } = requireProjectConfig(opts.cwd);
  const server = resolveServer(opts.server ?? config.server);
  const creds = await requireServerCredentials(server, parentEnv);
  const environment = await resolveEnvironmentName(config.projectId, opts.env, config.defaultEnvironment, parentEnv);
  const [file, ...args] = cmd;
  if (!file) throw new Error("cb run: missing command. Usage: cb run -- <command>");

  const agent = new Agent({
    serverUrl: server,
    token: creds.token,
    projectId: config.projectId,
    orgId: config.orgId,
    environment,
    correlationId: newCorrelationId(),
    env: parentEnv,
    portRange: opts.portRange,
    log: note,
  });
  await agent.start();
  note(
    `cb: ${config.projectSlug ?? config.projectId} / ${environment} — ${agent.bootstrap?.listeners.length ?? 0} brokered connection(s), ${agent.bootstrap?.redirects.length ?? 0} redirected host(s)`,
  );

  let child: ChildProcess | undefined;
  let restartRequested = false;
  let timer: NodeJS.Timeout | undefined;
  let revoked = false;

  const scheduleRefresh = () => {
    if (revoked) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const before = JSON.stringify(agent.snapshot?.env);
        await agent.start();
        if (JSON.stringify(agent.snapshot?.env) === before || opts.restart === false) return;
        note("cb: configuration changed — restarting your app");
        restartRequested = true;
        child?.kill("SIGTERM");
      } catch (err) {
        note(`cb: could not refresh configuration — ${err instanceof Error ? err.message : String(err)}`);
      }
    }, RESTART_DEBOUNCE_MS);
  };

  const events = subscribeAgentEvents({
    serverUrl: server,
    token: creds.token,
    envId: agent.bootstrap?.envId ?? "",
    correlationId: agent.opts.correlationId,
    onEvent: (event) => {
      if (event.type === "config.changed") scheduleRefresh();
      if (event.type === "access.revoked" && !revoked) {
        revoked = true;
        note(`\n${"!".repeat(72)}\n${MSG.revoked(event.reason)}\n${"!".repeat(72)}\n`);
        void agent.revoke(event.reason);
      }
    },
  });

  const onSigint = () => undefined; // the terminal delivers Ctrl+C to the child directly
  const forward = (signal: NodeJS.Signals) => () => child?.kill(signal);
  const onSigterm = forward("SIGTERM");
  const onSighup = forward("SIGHUP");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);

  try {
    for (;;) {
      if (!agent.snapshot) throw new Error("cb run: no snapshot");
      child = spawn(file, args, {
        stdio: "inherit",
        cwd: opts.cwd,
        env: buildChildEnv(parentEnv, agent.snapshot, agent.snapshotFile),
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
    clearTimeout(timer);
    events.close();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    await agent.stop();
  }
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run a command with cb-managed env and brokered connections")
    .option("--env <name>", "environment (default: project default or `cb env use`)")
    .option("--server <url>", "backend URL")
    .option("--no-restart", "do not restart the app when configuration changes")
    .argument("<cmd...>", "command to run, after --")
    .passThroughOptions()
    .action(async (cmd: string[], opts: { env?: string; server?: string; restart: boolean }) => {
      process.exitCode = await runCommand(cmd, opts);
    });
}
