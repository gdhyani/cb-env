import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { appendNodeOption, preloadNodeOption, quoteNodeOption } from "../../src/cli/node-options";

/** A preload that leaves a marker, in a folder whose name has spaces (§9.7). */
function markerPreload(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb oq6 "));
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, `(globalThis.__loaded ??= []).push(${JSON.stringify(name)});`);
  return file;
}
const loadedWith = (nodeOptions: string) =>
  spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(globalThis.__loaded ?? []))"], {
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    encoding: "utf8",
  }).stdout.trim();

describe("cb run preload option (OQ6, FR-PKG-004)", () => {
  it("OQ6 loads the preload with --import and a file URL by default", () => {
    const file = path.join(os.tmpdir(), "a b", "r.js");
    expect(preloadNodeOption(undefined, file)).toBe(`--import ${pathToFileURL(file).href}`);
    expect(preloadNodeOption("--max-old-space-size=256", file)).toBe(`--import ${pathToFileURL(file).href}`);
  });

  it("OQ6 keeps the developer's own --require: cb uses --import, so tools that merge repeated flags keep both", () => {
    expect(preloadNodeOption("--require ./mine.cjs", "/r.js")).toMatch(/^--import /);
    expect(preloadNodeOption("-r ./mine.cjs", "/r.js")).toMatch(/^--import /);
    expect(preloadNodeOption("--require=./mine.cjs", "/r.js")).toMatch(/^--import /);
  });

  it("OQ6 uses --require when the developer already uses --import", () => {
    expect(preloadNodeOption("--import tsx", "/a b/r.js")).toBe(`--require ${quoteNodeOption("/a b/r.js")}`);
    expect(preloadNodeOption("--import=tsx", "/r.js")).toBe(`--require ${quoteNodeOption("/r.js")}`);
  });

  it("OQ6 preload loads from a path with a space", () => {
    const cb = markerPreload("cb");
    expect(loadedWith(preloadNodeOption(undefined, cb))).toBe('["cb"]');
  });

  it("OQ6 keeps the developer's own preload: both run, the developer's first", () => {
    const mine = markerPreload("mine");
    const cb = markerPreload("cb");
    const parent = `--require ${quoteNodeOption(mine)}`;
    expect(loadedWith(appendNodeOption(parent, preloadNodeOption(parent, cb)))).toBe('["mine","cb"]');
  });
});
