import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cbHome, logsDir, snapshotPath, statePath } from "../../src/shared/paths";

describe("paths (PRD §9.6, FR-AGT-009)", () => {
  it("defaults to ~/.cb", () => expect(cbHome({})).toBe(path.join(os.homedir(), ".cb")));
  it("honours CB_HOME", () => expect(cbHome({ CB_HOME: path.join("x", "h") })).toBe(path.join("x", "h")));
  it("snapshot path is run/<projectId>.<env>.json", () =>
    expect(snapshotPath("p1", "development", { CB_HOME: "h" })).toBe(path.join("h", "run", "p1.development.json")));
  it("state and logs live under the home dir", () => {
    expect(statePath({ CB_HOME: "h" })).toBe(path.join("h", "state.json"));
    expect(logsDir({ CB_HOME: "h" })).toBe(path.join("h", "logs"));
  });
});
