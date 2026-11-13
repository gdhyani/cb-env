import { spawn } from "node:child_process";
import { preloadNodeOption } from "../../src/cli/node-options";
import { REGISTER } from "../helpers/run-node";

export interface StartupOptions {
  runs: number;
  warmup: number;
  /** "none": plain node; "shipped": the NODE_OPTIONS `cb run` adds (OQ6: --import by default); "require": --require. */
  mode: "none" | "shipped" | "require";
  snapshotPath: string;
}

function once(mode: StartupOptions["mode"], snapshotPath: string): Promise<number> {
  const args = [...(mode === "require" ? ["--require", REGISTER] : []), "-e", "0"];
  const nodeOptions = mode === "shipped" ? preloadNodeOption(undefined, REGISTER) : "";
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_OPTIONS: nodeOptions, CB_SNAPSHOT_PATH: snapshotPath },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(performance.now() - started);
      else reject(new Error(`node exited ${code}: ${stderr}`));
    });
  });
}

/** Wall-clock ms of `node -e 0` per run, with or without the cb preload; warm-up runs are discarded. */
export async function measureStartup(o: StartupOptions): Promise<number[]> {
  for (let i = 0; i < o.warmup; i++) await once(o.mode, o.snapshotPath);
  const out: number[] = [];
  for (let i = 0; i < o.runs; i++) out.push(await once(o.mode, o.snapshotPath));
  return out;
}
