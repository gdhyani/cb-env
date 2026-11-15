import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor } from "../e2e/harness/app";
import { loginCli, type Seeded } from "../e2e/harness/seed";
import { type Suite, startSuite } from "../e2e/harness/suite";

/**
 * §14 DX: onboarding (install → login → init → run) under 3 minutes. This measures the machine's share on a fresh
 * device and a fresh app: `cb login` (device code approved at once), `cb init --yes`, and the first `cb run` (agent
 * start + bootstrap + listeners). The human share (install, reading the code, clicking Approve) is timed by hand.
 */
const MACHINE_BUDGET_MS = 60_000;

function cb(suite: Suite, home: string, cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(suite.cfg.cbEnvDir, "dist/cli/index.js"), ...args], {
      cwd,
      env: cbEnvFor(home, suite.evidence, { NODE_OPTIONS: "" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
    });
    proc.stderr.on("data", (d) => {
      out += d;
    });
    proc.once("exit", (code) => resolve({ code, out }));
  });
}

describe("§14 onboarding time (M7)", () => {
  let suite: Suite;
  let seeded: Seeded;
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "cb-onboard-app-"));
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-onboard-seed-"));

  beforeAll(async () => {
    suite = await startSuite("onboarding");
    seeded = await suite.seed(seedDir, {
      resources: [
        {
          body: {
            kind: "http",
            name: "openai",
            upstreamUrl: suite.mocks.url("openai"),
            apiKey: suite.canaries.openai,
            redirectHosts: ["api.openai.com:443"],
          },
          vars: [["OPENAI_API_KEY", "key"]],
        },
      ],
      plain: { PORT: "3000" },
    });
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ name: "fresh-app", private: true, scripts: { dev: "node server.js" } }, null, 2),
    );
    fs.writeFileSync(path.join(app, "server.js"), "console.log(Boolean(process.env.OPENAI_API_KEY));\n");
  });
  afterAll(async () => {
    await suite?.close();
  });

  it("§14 machine time for login → init → first run is under 60 s", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-onboard-home-"));
    const t0 = performance.now();
    await loginCli(suite.cfg, seeded, home);
    const t1 = performance.now();
    const init = await cb(suite, home, app, [
      "init",
      "--yes",
      "--server",
      seeded.api,
      "--org",
      seeded.orgId,
      "--project",
      seeded.projectId,
      "--env",
      "development",
    ]);
    const t2 = performance.now();
    expect(init.code, init.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).scripts.dev).toMatch(/cb run/);
    const run = await cb(suite, home, app, ["run", "--no-restart", "--", "node", "server.js"]);
    const t3 = performance.now();
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain("true");
    await cb(suite, home, app, ["down"]);
    const steps = { login: t1 - t0, init: t2 - t1, firstRun: t3 - t2, total: t3 - t0 };
    console.log(
      `onboarding machine time: ${Object.entries(steps)
        .map(([k, v]) => `${k} ${(v / 1000).toFixed(2)} s`)
        .join(", ")}`,
    );
    expect(steps.total).toBeLessThan(MACHINE_BUDGET_MS);
  });
});
