import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveServerCredentials } from "../../src/shared/credentials";
import { credentialsPath } from "../../src/shared/paths";
import { ok, startStubServer } from "../helpers/stub-server";

const BIN = path.resolve("dist/cli/index.js");
const TOKEN = "cbd_cli_exposure_access_token_00000000000";
const REFRESH = "cbr_cli_exposure_refresh_token_000000000";
let stub: Awaited<ReturnType<typeof startStubServer>> | undefined;
afterEach(async () => stub?.close());

function cb(args: string[], cwd: string, home: string): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CB_HOME: home, CB_CREDENTIAL_STORE: "file" },
      cwd,
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("close", (status) => resolve({ status, output }));
  });
}

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function login(server: string, home: string) {
  await saveServerCredentials(
    server,
    {
      token: REFRESH,
      accessToken: TOKEN,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceId: "d1",
      deviceName: "test",
      user: { id: "u", name: "U", email: "u@x" },
    },
    { CB_HOME: home, CB_CREDENTIAL_STORE: "file" },
  );
}

describe("CLI surfaces never show a token or a value (K6, F1, F10)", () => {
  it("K6 cb run without a project link fails with an actionable message and no token", async () => {
    const home = tmp("cb-k6-home-");
    const dir = tmp("cb-k6-app-");
    stub = await startStubServer({});
    await login(stub.url, home);
    const r = await cb(["run", "--", process.execPath, "-e", "0"], dir, home);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/cb init/);
    expect(r.output).not.toContain(TOKEN);
    expect(r.output).not.toContain(REFRESH);
  });

  it("K6 cb run when not logged in says how to log in, and prints no token", async () => {
    const home = tmp("cb-k6b-home-");
    const dir = tmp("cb-k6b-app-");
    stub = await startStubServer({});
    fs.mkdirSync(path.join(dir, ".cb"));
    fs.writeFileSync(
      path.join(dir, ".cb", "project.json"),
      JSON.stringify({ server: stub.url, orgId: "o", projectId: "p1", defaultEnvironment: "development" }),
    );
    const r = await cb(["run", "--", process.execPath, "-e", "0"], dir, home);
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/cb login/);
  });

  it("F1 cb never writes a .env file into the project", async () => {
    const home = tmp("cb-f1-home-");
    const dir = tmp("cb-f1-app-");
    stub = await startStubServer({});
    await login(stub.url, home);
    await cb(["run", "--", process.execPath, "-e", "0"], dir, home);
    await cb(["doctor"], dir, home);
    await cb(["status"], dir, home);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".env"))).toEqual([]);
  });

  it("F10 cb logout revokes server-side and removes the token from CB_HOME", async () => {
    const home = tmp("cb-f10-home-");
    stub = await startStubServer({ "/api/cli/logout": ok({ revoked: true }) });
    await login(stub.url, home);
    const file = credentialsPath({ CB_HOME: home });
    expect(fs.readFileSync(file, "utf8")).toContain(REFRESH);
    const r = await cb(["logout", "--server", stub.url], home, home);
    expect(r.status, r.output).toBe(0);
    expect(stub.seen.some((h) => h.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const left = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    expect(left).not.toContain(REFRESH);
    expect(left).not.toContain(TOKEN);
    expect(r.output).not.toContain(TOKEN);
  });
});
