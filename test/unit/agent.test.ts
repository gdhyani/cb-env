import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocatePorts, isPortFree } from "../../src/agent/ports";
import { renderSnapshot } from "../../src/agent/snapshot";
import { wrapScripts } from "../../src/cli/commands/init";
import { appendNodeOption, buildChildEnv, quoteNodeOption } from "../../src/cli/commands/run";
import { getServerCredentials, removeServerCredentials, saveServerCredentials } from "../../src/shared/credentials";
import { keychainEnabled } from "../../src/shared/keychain";
import type { Bootstrap } from "../../src/shared/schemas";

const occupy = (port: number) =>
  new Promise<net.Server>((resolve) => {
    const s = net.createServer();
    s.listen(port, "127.0.0.1", () => resolve(s));
  });

describe("ports (FR-AGT-003)", () => {
  it("reuses persisted ports, fills new keys, skips busy ports", async () => {
    const blocker = await occupy(7951);
    expect(await isPortFree(7951)).toBe(false);
    const ports = await allocatePorts(["a", "b"], { a: 7950 }, { min: 7950, max: 7959 });
    expect(ports).toEqual({ a: 7950, b: 7952 });
    blocker.close();
  });
});

const BOOT: Bootstrap = {
  schema: 1,
  version: 4,
  orgId: "o",
  projectId: "p",
  projectSlug: "shop",
  environment: "development",
  envId: "e",
  orgCaCert: "CERT",
  plain: { PORT: "3000", KEY: "sk_cb_x" },
  listeners: [{ resourceId: "r1", kind: "redis", name: "cache", env: { REDIS_URL: "redis://u:p@127.0.0.1:{port}" } }],
  redirects: [{ host: "API.provider.test", port: 443, resourceId: "r2" }],
  visibleKeys: [],
  files: {},
};

describe("snapshot (§12.4)", () => {
  it("fills listener ports and maps redirects", () => {
    const ports: Record<string, number> = { "l1:r1": 7401, "l2:api.provider.test:443": 7402 };
    const snap = renderSnapshot(BOOT, (k) => ports[k] ?? 0);
    expect(snap.env).toEqual({ PORT: "3000", KEY: "sk_cb_x", REDIS_URL: "redis://u:p@127.0.0.1:7401" });
    expect(snap.redirects).toEqual({ "api.provider.test:443": 7402 });
  });
});

describe("cb init script wiring (FR-PKG-003)", () => {
  it("prefixes Node tool scripts once and leaves others alone", () => {
    expect(
      wrapScripts({
        dev: "node --watch server.js",
        start: "next start",
        lint: "biome check .",
        done: "cb run -- node x.js",
      }),
    ).toEqual({
      dev: { from: "node --watch server.js", to: "cb run -- node --watch server.js" },
      start: { from: "next start", to: "cb run -- next start" },
    });
  });
});

describe("cb run child env (FR-PKG-004)", () => {
  it("snapshot wins, CB_SNAPSHOT_PATH is set, existing NODE_OPTIONS kept", () => {
    const snap = renderSnapshot(BOOT, () => 7401);
    const env = buildChildEnv({ PORT: "9999", NODE_OPTIONS: "--max-old-space-size=256" }, snap, "/s.json", "/r.js");
    expect(env.PORT).toBe("3000");
    expect(env.CB_SNAPSHOT_PATH).toBe("/s.json");
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=256 --require "/r.js"');
    expect(appendNodeOption('--require "/r.js"', '--require "/r.js"')).toBe('--require "/r.js"');
  });

  it("a register path with spaces survives NODE_OPTIONS quoting (§9.7)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb dir with space "));
    const file = path.join(dir, "r.js");
    fs.writeFileSync(file, "globalThis.__cbLoaded = true;");
    const r = spawnSync(process.execPath, ["-e", "console.log(globalThis.__cbLoaded === true)"], {
      env: { ...process.env, NODE_OPTIONS: `--require ${quoteNodeOption(file)}` },
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe("true");
  });
});

describe("credentials (M0-D3)", () => {
  it.skipIf(process.platform === "win32")("stores device tokens with 0600 permissions", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-creds-"));
    const env = { CB_HOME: home };
    await saveServerCredentials(
      "http://localhost:4200/",
      { token: "cbd_x", deviceId: "d", deviceName: "mbp", user: { id: "u", name: "A", email: "a@x" } },
      env,
    );
    expect((fs.statSync(path.join(home, "credentials.json")).mode & 0o777).toString(8)).toBe("600");
    expect((await getServerCredentials("http://localhost:4200", env))?.token).toBe("cbd_x");
  });

  // Opt-in: writes one temporary item to the real OS keychain and removes it.
  it.runIf(process.env.CB_TEST_KEYCHAIN === "1")(
    "FR-PKG-001 keeps the token in the OS keychain, not on disk",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cb-keychain-"));
      const env = { CB_HOME: home, CB_CREDENTIAL_STORE: "keychain" };
      expect(keychainEnabled(env)).toBe(true);
      const user = { id: "u", name: "A", email: "a@x" };
      const where = await saveServerCredentials(
        "http://localhost:4200",
        { token: "cbd_keychain_canary", deviceId: "d", deviceName: "mbp", user },
        env,
      );
      expect(where).toBe("keychain");
      expect(fs.readFileSync(path.join(home, "credentials.json"), "utf8")).not.toContain("cbd_keychain_canary");
      expect((await getServerCredentials("http://localhost:4200", env))?.token).toBe("cbd_keychain_canary");
      await removeServerCredentials("http://localhost:4200", env);
      expect(await getServerCredentials("http://localhost:4200", env)).toBeUndefined();
    },
  );
});
