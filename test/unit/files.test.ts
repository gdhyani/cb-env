import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogWriter, openPrivate } from "../../src/shared/files";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-files-"));
const isOpen = (fd: number) => {
  try {
    fs.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => vi.restoreAllMocks());

describe("private files (P10, M7)", () => {
  it("M7 openPrivate closes the descriptor when tightening permissions fails", () => {
    if (process.platform === "win32") return; // no chmod step on Windows
    const file = path.join(tmp(), "agent.log");
    const realOpen = fs.openSync;
    let fd = -1;
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
      fd = realOpen(...args);
      return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });
    expect(() => openPrivate(file, "a")).toThrow("EPERM");
    expect(fd).toBeGreaterThanOrEqual(0);
    expect(isOpen(fd)).toBe(false);
  });

  it("M7 FR-AGT-008 the agent log keeps one handle across lines and reopens only on rotation", () => {
    const file = path.join(tmp(), "agent.log");
    const opens = vi.spyOn(fs, "openSync");
    const log = createLogWriter(file, 200);
    for (let i = 0; i < 3; i++) log.write(`line ${i}`);
    expect(opens).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(file, "utf8").split("\n").filter(Boolean)).toEqual(["line 0", "line 1", "line 2"]);

    // Past maxBytes: the current file becomes agent.log.1 and new lines go to a fresh agent.log.
    for (let i = 3; i < 40; i++) log.write(`line ${i}`);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.readFileSync(file, "utf8")).toContain("line 39");
    expect(opens.mock.calls.length).toBeLessThan(10);
    log.close();
  });
});
