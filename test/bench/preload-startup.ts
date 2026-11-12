import { spawn } from "node:child_process";
import { REGISTER } from "../helpers/run-node";

export interface StartupOptions {
  runs: number;
  warmup: number;
  withPreload: boolean;
  snapshotPath: string;
}

function once(withPreload: boolean, snapshotPath: string): Promise<number> {
  const args = [...(withPreload ? ["--require", REGISTER] : []), "-e", "0"];
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, NODE_OPTIONS: "", CB_SNAPSHOT_PATH: snapshotPath },
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
  for (let i = 0; i < o.warmup; i++) await once(o.withPreload, o.snapshotPath);
  const out: number[] = [];
  for (let i = 0; i < o.runs; i++) out.push(await once(o.withPreload, o.snapshotPath));
  return out;
}
