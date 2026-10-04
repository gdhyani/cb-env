import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ENV, HOME_DIR_NAME } from "../constants";

export function cbHome(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV.home] ?? path.join(os.homedir(), HOME_DIR_NAME);
}

export function snapshotPath(projectId: string, environment: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cbHome(env), "run", `${projectId}.${environment}.json`);
}

export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cbHome(env), "state.json");
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cbHome(env), "logs");
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cbHome(env), "credentials.json");
}

/**
 * FR-AGT-001: control socket per CB_HOME (Unix socket, or a named pipe on Windows).
 * Unix socket paths are limited to ~104 bytes, so long homes use a hashed path in the temp dir.
 */
export function agentSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = cbHome(env);
  const id = createHash("sha256").update(home).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\cb-agent-${os.userInfo().username}-${id}`;
  const inHome = path.join(home, "agent.sock");
  return Buffer.byteLength(inHome) < 100 ? inHome : path.join(os.tmpdir(), `cb-agent-${id}.sock`);
}

export function agentLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(logsDir(env), "agent.log");
}
