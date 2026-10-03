import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Snapshot } from "../../src/shared/schemas";

export const REGISTER = path.resolve("dist/register/index.js");

export function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

/** Async variant: needed whenever the child talks to servers running inside the test process. */
export function runNodeAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: stdout.trim(), stderr });
    });
  });
}

export function writeSnapshot(partial: Partial<Snapshot> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb snap "));
  const file = path.join(dir, "proj.development.json");
  const snap: Snapshot = {
    schema: 1,
    version: 1,
    status: "active",
    projectId: "proj",
    environment: "development",
    env: {},
    redirects: {},
    fakeFiles: {},
    orgCaCert: "",
    visibleKeys: [],
    ...partial,
  };
  fs.writeFileSync(file, JSON.stringify(snap));
  return file;
}
