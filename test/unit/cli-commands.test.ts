import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../../src/api";
import { envFiles, scanEnvFiles } from "../../src/cli/commands/doctor";
import { promptEnv } from "../../src/cli/commands/shell";
import { renderEnvTypes } from "../../src/cli/commands/types";
import { runNode } from "../helpers/run-node";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("explicit env API (FR-API-001/002/005)", () => {
  it("FR-API-001 returns exactly process.env, synchronously", () => {
    process.env.CB_TEST_VALUE = "fake-123";
    expect((env as unknown as Record<string, string>).CB_TEST_VALUE).toBe("fake-123");
    expect(env.get("CB_TEST_VALUE")).toBe("fake-123");
    expect(env.get("CB_TEST_NOPE")).toBeUndefined();
  });

  it("FR-API-002 under cb run, a missing variable throws naming it; FR-API-005 outside, it is undefined", () => {
    const read = () => (env as unknown as Record<string, string | undefined>).CB_TEST_MISSING;
    delete process.env.CB_SNAPSHOT_PATH;
    expect(read()).toBeUndefined();
    process.env.CB_SNAPSHOT_PATH = "/tmp/snapshot.json";
    expect(read).toThrow(/CB_TEST_MISSING is not set/);
    expect(() => {
      (env as unknown as Record<string, string>).X = "y";
    }).toThrow(/read-only/);
  });

  it("FR-API-003 the browser build throws at import", () => {
    const r = runNode(["-e", 'require("./dist/api/browser-stub.js")']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("@cb/env is server-only");
  });
});

describe("cb types (FR-PKG-010)", () => {
  it("renders names only, merged into CbEnv and NodeJS.ProcessEnv", () => {
    const dts = renderEnvTypes(["DATABASE_URL", "STRIPE_KEY", "DATABASE_URL", "weird-key"], "shop / development");
    expect(dts).toContain('declare module "@cb/env"');
    expect(dts).toContain("readonly DATABASE_URL: string;");
    expect(dts).toContain('readonly "weird-key": string;');
    expect(dts.match(/readonly DATABASE_URL/g)).toHaveLength(2); // CbEnv + ProcessEnv, deduplicated
    expect(dts).not.toMatch(/=\s*"/); // no values, ever
  });
});

describe("cb doctor .env scan (FR-PKG-009)", () => {
  it("flags real-looking secrets and cb-managed keys, ignores examples", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-doctor-"));
    fs.writeFileSync(
      path.join(dir, ".env"),
      [
        "DATABASE_URL=postgres://admin:hunter2@db.internal:5432/app",
        "STRIPE_SECRET_KEY=sk_live_abcdefghijkl123",
        "PORT=3000",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, ".env.local"), "REDIS_URL=redis://127.0.0.1:6379\n");
    fs.writeFileSync(path.join(dir, ".env.example"), "STRIPE_SECRET_KEY=sk_live_example_only_aaaa\n");
    const files = envFiles(dir);
    expect(files.map((f) => path.basename(f)).sort()).toEqual([".env", ".env.local"]);
    const checks = scanEnvFiles(files, new Set(["REDIS_URL"]));
    const env1 = checks.find((c) => c.name === ".env: real-looking secrets");
    expect(env1?.status).toBe("fail");
    expect(env1?.detail).toContain("Stripe live key");
    expect(env1?.detail).toContain("database URL with a password");
    expect(checks.find((c) => c.name === ".env.local: cb-managed keys")).toMatchObject({
      status: "warn",
      detail: "REDIS_URL",
    });
  });
});

describe("cb shell (FR-PKG-006)", () => {
  it("prefixes the prompt with the environment for bash and zsh", () => {
    expect(promptEnv({ PS1: "$ " }, "/bin/bash", "staging").PS1).toBe("(cb:staging) $ ");
    expect(promptEnv({}, "/bin/zsh", "development").PROMPT).toMatch(/^\(cb:development\) /);
  });
});

describe("cb up / down / doctor (FR-PKG-011, FR-PKG-012)", () => {
  it("FR-PKG-011 up starts the agent, down stops it; FR-PKG-012 doctor --json exits non-zero on failures", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbu-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cbu-proj-"));
    const cli = (args: string[]) =>
      runNode(
        [path.resolve("dist/cli/index.js"), ...args],
        { CB_HOME: home, CB_SERVER_URL: "http://127.0.0.1:9" },
        cwd,
      );
    const up = cli(["up", "--json"]);
    expect(up.status).toBe(0);
    expect(JSON.parse(up.stdout)).toMatchObject({ running: true, attached: null });
    const status = cli(["agent", "status", "--json"]);
    expect(JSON.parse(status.stdout).running).toBe(true);
    expect(cli(["down"]).stdout).toContain("stopped");

    const doctor = cli(["doctor", "--json"]);
    expect(doctor.status).toBe(1); // server unreachable, not logged in
    const report = JSON.parse(doctor.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: { name: string }) => c.name === "Server").status).toBe("fail");
    expect(report.checks.find((c: { name: string }) => c.name === "Node.js").status).toBe("ok");
  });
});
