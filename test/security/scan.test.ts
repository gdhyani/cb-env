import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listFiles, scanEvidence } from "../e2e/harness/scan";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
const write = (name: string, content: string | Buffer) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
};
const canary = "CANARY_stripe_0123456789abcdef01234567";
const jsonEscapeAll = (s: string) =>
  [...s].map((ch) => (/[A-Za-z0-9]/.test(ch) ? ch : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)).join("");

describe("canary scanner (§13)", () => {
  it("S1 finds raw, base64 (any alignment), base64url and JSON-escaped canaries", () => {
    const report = scanEvidence([canary], {
      raw: [write("a.txt", `x${canary}y`)],
      b64: [write("b.txt", Buffer.from(`user:${canary}`).toString("base64"))],
      b64url: [write("c.txt", Buffer.from(canary).toString("base64url"))],
      json: [write("d.json", `{"k":"${jsonEscapeAll(canary)}"}`)],
    });
    expect(report.leaks.map((l) => l.target).sort()).toEqual(["b64", "b64url", "json", "raw"]);
  });

  it("S1 a clean file reports no leak", () => {
    expect(scanEvidence([canary], { clean: [write("e.txt", "nothing here")] }).leaks).toEqual([]);
  });

  it("refuses a target with no evidence files, so a broken hook cannot pass silently", () => {
    expect(() => scanEvidence([canary], { "app heap": [] })).toThrow(/no evidence for app heap/);
  });

  it("refuses canaries too short to scan reliably", () => {
    expect(() => scanEvidence(["short"], { clean: [write("f.txt", "x")] })).toThrow(/too short/);
  });

  it("listFiles returns regular files only, recursively (CB_HOME also holds a socket)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lf-"));
    fs.mkdirSync(path.join(root, "a"));
    fs.writeFileSync(path.join(root, "a", "x.json"), "{}");
    fs.writeFileSync(path.join(root, "y.log"), "");
    expect(
      listFiles(root)
        .map((f) => path.relative(root, f))
        .sort(),
    ).toEqual([path.join("a", "x.json"), "y.log"]);
  });
});
