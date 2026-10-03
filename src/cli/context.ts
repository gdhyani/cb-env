import { DEFAULT_SERVER, ENV } from "../constants";
import { findProjectConfig } from "../shared/project-config";

/** Server precedence: --server flag > CB_SERVER_URL > .cb/project.json > default. */
export function resolveServer(flag?: string): string {
  return (flag ?? process.env[ENV.server] ?? findProjectConfig()?.config.server ?? DEFAULT_SERVER).replace(/\/+$/, "");
}

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function note(line: string): void {
  process.stderr.write(`${line}\n`);
}
