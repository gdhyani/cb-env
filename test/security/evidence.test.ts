import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { servicesAvailable } from "../e2e/harness/config";
import { hookedProcesses } from "../e2e/harness/evidence";
import { scanEvidence } from "../e2e/harness/scan";

const hook = path.join(__dirname, "../e2e/harness/evidence-hook.cjs");

describe("evidence hook (§13 canary suite)", () => {
  it("S1 a canary deep inside a long string is still in the heap snapshot (no 1024-char truncation)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-"));
    const canary = "CANARY_long_0123456789abcdef0123";
    // The secret sits at offset 5000 of a flat string, as in a large response body the app kept.
    // Only shifted char codes appear in the script, so the one full copy of the canary is inside the long string.
    const codes = JSON.stringify([...canary].map((ch) => ch.charCodeAt(0) + 1));
    const script = `const c = ${codes}; globalThis.keep = Array.from({ length: 5100 }, (_, i) => i < 5000 ? "x" : i < 5000 + c.length ? String.fromCharCode(c[i - 5000] - 1) : "y").join(""); setTimeout(() => {}, 20000);`;
    const child = spawn(process.execPath, ["-e", script], {
      env: { ...process.env, CB_E2E_EVIDENCE_DIR: dir, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}` },
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      fs.writeFileSync(path.join(dir, "dump.request"), "1");
      const snap = path.join(dir, `app.${child.pid}.heapsnapshot`);
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(path.join(dir, `dump.${child.pid}.1`)) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      const report = scanEvidence([canary], { heap: [snap] });
      expect(report.leaks).toHaveLength(1);
    } finally {
      child.kill();
    }
  });

  it("classifies hooked processes so app evidence is never satisfied by cb's own processes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cls-"));
    fs.writeFileSync(path.join(dir, "hooked.11"), "/x/cb-env/dist/cli/index.js run -- npm run dev");
    fs.writeFileSync(path.join(dir, "hooked.12"), "/x/cb-env/dist/agent/main.js");
    fs.writeFileSync(path.join(dir, "hooked.13"), "/usr/bin/npm run dev");
    fs.writeFileSync(path.join(dir, "hooked.14"), "/x/examples/express-mongo/src/server.js");
    const procs = hookedProcesses(dir);
    expect(procs.filter((p) => p.role === "cb").map((p) => p.pid)).toEqual([11, 12]);
    expect(procs.filter((p) => p.role === "app").map((p) => p.pid)).toEqual([13, 14]);
  });
});

describe("e2e prerequisites", () => {
  it("CB_E2E_REQUIRED=1 turns missing services into an error instead of a silent skip", () => {
    expect(servicesAvailable({})).toBe(false);
    expect(() => servicesAvailable({ CB_E2E_REQUIRED: "1" })).toThrow(/CB_TEST_DB_PASSWORD/);
    expect(
      servicesAvailable({
        CB_E2E_REQUIRED: "1",
        CB_TEST_DB_PASSWORD: "x".repeat(8),
        CB_TEST_REDIS_PASSWORD: "y".repeat(8),
      }),
    ).toBe(true);
  });
});
