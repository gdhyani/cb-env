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
