import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("browser stub (FR-API-003, T3)", () => {
  it("T3 the browser build of @cb/env imports server-only so Next.js fails client builds", () => {
    const src = readFileSync(path.join(__dirname, "../../dist/api/browser-stub.js"), "utf8");
    expect(src).toMatch(/require\("server-only"\)/);
  });

  it("FR-API-003 other bundlers still get a clear server-only error at runtime", () => {
    const src = readFileSync(path.join(__dirname, "../../dist/api/browser-stub.js"), "utf8");
    expect(src).toContain("@cb/env is server-only");
  });
});
