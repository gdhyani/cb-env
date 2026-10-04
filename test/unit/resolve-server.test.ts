import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/cli/commands/run";
import { resolveServer } from "../../src/cli/context";
import { saveServerCredentials } from "../../src/shared/credentials";

const saved = process.env.CB_SERVER_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.CB_SERVER_URL;
  else process.env.CB_SERVER_URL = saved;
});

describe("server precedence: --server > CB_SERVER_URL > .cb/project.json > default", () => {
  it("cb run honours CB_SERVER_URL over the project's server", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "cb-proj-"));
    fs.mkdirSync(path.join(project, ".cb"));
    fs.writeFileSync(
      path.join(project, ".cb", "project.json"),
      JSON.stringify({
        server: "http://localhost:4200",
        orgId: "o",
        projectId: "p",
        defaultEnvironment: "development",
      }),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-home-"));
    const env = { CB_HOME: home, CB_CREDENTIAL_STORE: "file", CB_ENVIRONMENT: "development" };
    // Logged in only on the other server.
    await saveServerCredentials(
      "http://localhost:4300",
      { token: "cbd_x", deviceId: "d", deviceName: "mbp", user: { id: "u", name: "A", email: "a@x" } },
      env,
    );
    process.env.CB_SERVER_URL = "http://localhost:4300";
    const err = await runCommand(["node", "-e", "0"], { cwd: project, processEnv: { ...process.env, ...env } }).catch(
      (e: { code?: string }) => e,
    );
    // Past the login check (it fails later, without a running agent) — not "you're not logged in".
    expect((err as { code?: string }).code).not.toBe("NOT_LOGGED_IN");
  });

  it("the --server flag wins over everything; the project's server is used when nothing else is set", () => {
    process.env.CB_SERVER_URL = "http://localhost:4300";
    expect(resolveServer("http://flag:1", "http://localhost:4200")).toBe("http://flag:1");
    delete process.env.CB_SERVER_URL;
    expect(resolveServer(undefined, "http://localhost:4200/")).toBe("http://localhost:4200");
  });
});
