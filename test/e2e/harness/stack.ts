import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { HarnessConfig } from "./config";

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const waitForText = async (file: string, text: string, ms: number, proc: ChildProcess) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(text)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tail = fs.existsSync(file) ? fs.readFileSync(file, "utf8").slice(-2000) : "(no log)";
  throw new Error(`backend did not become ready:\n${tail}`);
};

/** The real cb backend from source, with fresh keys and debug logging (the strictest S9 check), logs captured. */
export async function startBackend(cfg: HarnessConfig, opts: { mongoUri: string; caFile: string; logFile: string }) {
  const port = await freePort();
  const log = fs.openSync(opts.logFile, "a");
  const proc = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: cfg.backendDir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      PORT: String(port),
      LOG_LEVEL: "debug",
      MONGODB_URI: opts.mongoUri,
      MASTER_KEY: randomBytes(32).toString("base64"),
      SERVER_SECRET: randomBytes(32).toString("base64"),
      DASHBOARD_URL: `http://127.0.0.1:${port}`,
      UPSTREAM_EXTRA_CA_FILE: opts.caFile,
    },
    stdio: ["ignore", log, log],
  });
  await waitForText(opts.logFile, "ready on :", 60_000, proc);
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (proc.exitCode !== null) return;
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
      fs.closeSync(log);
    },
  };
}
