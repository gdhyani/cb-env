import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fail, HEALTH, ok, startStubServer } from "../helpers/stub-server";

const BIN = path.resolve("dist/cli/index.js");
const CB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "cb-status-"));
let stub: Awaited<ReturnType<typeof startStubServer>> | undefined;
afterEach(async () => stub?.close());

/** Async spawn: a sync spawn would block this process, and with it the in-process stub server. */
function cb(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CB_HOME: CB_HOME_DIR,
        CB_CREDENTIAL_STORE: "file",
      },
      cwd: CB_HOME_DIR,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

describe("cb CLI (FR-PKG-008, FR-PKG-012)", () => {
  it("prints its version", async () => {
    expect((await cb(["--version"])).stdout).toBe("0.0.0");
  });

  it("FR-PKG-008 cb status shows backend health", async () => {
    stub = await startStubServer({ "/api/health": ok(HEALTH) });
    const r = await cb(["status", "--server", stub.url]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(stub.url);
    expect(r.stdout).toContain("ok");
    expect(r.stdout).toContain("mongodb up");
    expect(r.stdout).toContain("12m");
  });

  it("FR-PKG-012 cb status --json prints the health data", async () => {
    stub = await startStubServer({ "/api/health": ok(HEALTH) });
    const r = await cb(["status", "--server", stub.url, "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ server: stub.url, health: HEALTH, user: null });
  });

  it("FR-PKG-012 unreachable backend exits 1 with an actionable message", async () => {
    const r = await cb(["status", "--server", "http://127.0.0.1:1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("can't reach http://127.0.0.1:1");
  });

  it("FR-PKG-012 backend errors show the message and correlation id", async () => {
    stub = await startStubServer({
      "/api/health": fail(503, "SERVICE_UNAVAILABLE", "The service is down.", "corr-503"),
    });
    const r = await cb(["status", "--server", stub.url]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("The service is down.");
    expect(r.stderr).toContain("correlation id: corr-503");
  });
});
