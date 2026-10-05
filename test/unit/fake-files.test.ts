import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFakeFiles } from "../../src/agent/fake-files";
import { renderSnapshot } from "../../src/agent/snapshot";
import type { Bootstrap } from "../../src/shared/schemas";

const BOOT = {
  schema: 1,
  version: 3,
  orgId: "o",
  projectId: "p1",
  projectSlug: "shop",
  environment: "development",
  envId: "e1",
  orgCaCert: "",
  plain: { PORT: "3000" },
  listeners: [],
  redirects: [],
  visibleKeys: [],
  files: { GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account","private_key":"FAKE"}' },
} as Bootstrap;

describe("OQ8 fake key files (GOOGLE_APPLICATION_CREDENTIALS)", () => {
  it("writes each file 0600 under CB_HOME/fake and points the key (and fakeFiles) at its path", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbf-"));
    const paths = await writeFakeFiles(BOOT, { CB_HOME: home });
    const file = paths.GOOGLE_APPLICATION_CREDENTIALS ?? "";
    expect(file.startsWith(path.join(home, "fake"))).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(BOOT.files.GOOGLE_APPLICATION_CREDENTIALS);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const snap = renderSnapshot(BOOT, () => 0, paths);
    expect(snap.env.GOOGLE_APPLICATION_CREDENTIALS).toBe(file);
    expect(snap.fakeFiles).toEqual({ GOOGLE_APPLICATION_CREDENTIALS: file });
  });

  it("a key name can never escape the fake folder", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cbf-"));
    const paths = await writeFakeFiles({ ...BOOT, files: { "../../evil": "x" } } as Bootstrap, { CB_HOME: home });
    for (const p of Object.values(paths)) expect(p.startsWith(path.join(home, "fake"))).toBe(true);
  });
});
