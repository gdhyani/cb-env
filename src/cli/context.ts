import { DEFAULT_SERVER, ENV } from "../constants";
import { findProjectConfig } from "../shared/project-config";

/**
 * Server precedence: --server flag > CB_SERVER_URL > .cb/project.json > default.
 * `projectServer` is a project config the caller already loaded (it must never take the flag's place).
 */
export function resolveServer(flag?: string, projectServer?: string): string {
  return (
    flag ??
    process.env[ENV.server] ??
    projectServer ??
    findProjectConfig()?.config.server ??
    DEFAULT_SERVER
  ).replace(/\/+$/, "");
}

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function note(line: string): void {
  process.stderr.write(`${line}\n`);
}
