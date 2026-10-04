import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface RunningApp {
  /** Asks every live hooked process for its env + heap snapshot and waits for all of them. */
  dumpEvidence(): Promise<string[]>;
  /** §13: the agent's heap via the test-mode IPC command. */
  agentHeapSnapshot(file: string): Promise<void>;
  stop(): Promise<void>;
}

/** The harness's own secrets (compose passwords) must not reach the app through the inherited environment. */
const HARNESS_ONLY = ["CB_TEST_DB_PASSWORD", "CB_TEST_REDIS_PASSWORD"];

export function cbEnvFor(cbHome: string, evidenceDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HARNESS_ONLY.includes(k)));
  return {
    ...inherited,
    CB_HOME: cbHome,
    CB_CREDENTIAL_STORE: "file",
    CB_TEST_MODE: "1",
    CB_E2E_EVIDENCE_DIR: evidenceDir,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "evidence-hook.cjs"))}`,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  };
}

/** `cb run -- <command>` in an example folder, to completion (builds, migrations). Output appended to cli.log. */
export async function cbRunOnce(
  cfg: HarnessConfig,
  opts: { dir: string; command: string[]; env: NodeJS.ProcessEnv; logFile: string },
) {
  const log = fs.openSync(opts.logFile, "a");
  const proc = spawn(process.execPath, [path.join(cfg.cbEnvDir, "dist/cli/index.js"), "run", "--", ...opts.command], {
    cwd: opts.dir,
    env: opts.env,
    stdio: ["ignore", log, log],
  });
  const code = await new Promise<number | null>((r) => proc.once("exit", r));
  fs.closeSync(log);
  if (code !== 0) throw new Error(`cb run ${opts.command.join(" ")} exited ${code}; see ${opts.logFile}`);
}

/** Long-running `cb run -- <command>`; resolves once readyUrl answers 200. */
export async function runExample(
  cfg: HarnessConfig,
  opts: {
    dir: string;
    command: string[];
    readyUrl: string;
    env: NodeJS.ProcessEnv;
    evidenceDir: string;
    logFile: string;
    readyMs?: number;
  },
): Promise<RunningApp> {
  const log = fs.openSync(opts.logFile, "a");
  const proc: ChildProcess = spawn(
    process.execPath,
    [path.join(cfg.cbEnvDir, "dist/cli/index.js"), "run", "--", ...opts.command],
    {
      cwd: opts.dir,
      env: opts.env,
      stdio: ["ignore", log, log],
      detached: process.platform !== "win32",
    },
  );
  const deadline = Date.now() + (opts.readyMs ?? 60_000);
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    ready = await fetch(opts.readyUrl).then(
      (r) => r.ok,
      () => false,
    );
    if (!ready) await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    proc.kill("SIGKILL");
    throw new Error(
      `${opts.command.join(" ")} never became ready:\n${fs.readFileSync(opts.logFile, "utf8").slice(-3000)}`,
    );
  }

  const ipc = require(
    path.join(cfg.cbEnvDir, "dist/shared/agent-ipc.js"),
  ) as typeof import("../../../src/shared/agent-ipc");
  return {
    async dumpEvidence() {
      const stamp = String(Date.now());
      fs.writeFileSync(path.join(opts.evidenceDir, "dump.request"), stamp);
      const end = Date.now() + 60_000;
      for (;;) {
        const pids = fs
          .readdirSync(opts.evidenceDir)
          .filter((f) => /^hooked\.\d+$/.test(f))
          .map((f) => Number(f.split(".")[1]))
          .filter(alive);
        const pending = pids.filter((pid) => !fs.existsSync(path.join(opts.evidenceDir, `dump.${pid}.${stamp}`)));
        if (pids.length > 0 && pending.length === 0) return pids.map(String);
        if (Date.now() > end) throw new Error(`no evidence from pids ${pending.join(", ") || "(none hooked)"}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    async agentHeapSnapshot(file: string) {
      const conn = await ipc.connectAgent(opts.env);
      if (!conn) throw new Error("agent not running");
      conn.send({ type: "heap-snapshot", file });
      const reply = await conn.next("heap-snapshot");
      conn.close();
      if (reply.type !== "heap-snapshot") throw new Error(`agent refused heap snapshot: ${JSON.stringify(reply)}`);
    },
    async stop() {
      if (proc.exitCode === null && proc.pid) {
        const exited = new Promise<void>((r) => proc.once("exit", () => r()));
        // Signal the whole group: cb run forwards to the app, but Next workers may linger.
        try {
          process.kill(-proc.pid, "SIGINT");
        } catch {
          proc.kill("SIGINT");
        }
        await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
        if (proc.exitCode === null) {
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {
            proc.kill("SIGKILL");
          }
        }
      }
      fs.closeSync(log);
      const conn = await ipc.connectAgent(opts.env);
      if (conn) {
        conn.send({ type: "stop" });
        await conn.next("stopping").catch(() => undefined);
        conn.close();
      }
    },
  };
}
