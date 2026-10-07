import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quoteNodeOption } from "../../src/cli/commands/run";
import { REGISTER, runNode, writeSnapshot } from "../helpers/run-node";

/**
 * What an app under cb run — and anything it starts — can read (security guide §7.1–7.2). The laptop never holds a
 * real secret, so the proof is: every place shows exactly the snapshot's stand-ins, and no hidden cb variable carries
 * anything but paths and ids.
 */
const STANDIN = "sk_test_cbSTANDIN0000000000000000000000000001";
const snapshot = () => writeSnapshot({ env: { STRIPE_SECRET_KEY: STANDIN, PORT: "3000" }, visibleKeys: [] });
// Quoted the way cb run does it: Node reads backslashes in NODE_OPTIONS as escapes, which breaks Windows paths.
const nodeOptions = `--require ${quoteNodeOption(REGISTER)}`;
const hasPython = spawnSync("python3", ["-c", "0"]).status === 0;

/** Runs `code` the way cb run starts an app: snapshot path + NODE_OPTIONS preload, nothing else. */
function app(code: string) {
  const r = runNode(["-e", code], { CB_SNAPSHOT_PATH: snapshot(), NODE_OPTIONS: nodeOptions });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("app process and children see stand-ins only (R1–R8, C1–C5)", () => {
  it("R1 R2 the app reads the stand-in every way, and CB_* variables hold only paths and ids", () => {
    const out = app(`
      const { STRIPE_SECRET_KEY } = process.env;
      const all = { ...process.env };
      const cb = Object.entries(process.env).filter(([k]) => k.startsWith("CB_"));
      console.log(JSON.stringify({
        direct: process.env.STRIPE_SECRET_KEY, indexed: process.env["STRIPE_SECRET_KEY"], destructured: STRIPE_SECRET_KEY,
        spread: all.STRIPE_SECRET_KEY, keys: Reflect.ownKeys(process.env).includes("STRIPE_SECRET_KEY"),
        inspect: require("util").inspect(process.env).includes(${JSON.stringify(STANDIN)}),
        cb,
      }));`);
    expect(out).toMatchObject({
      direct: STANDIN,
      indexed: STANDIN,
      destructured: STANDIN,
      spread: STANDIN,
      keys: true,
      inspect: true,
    });
    for (const [k, v] of out.cb as [string, string][])
      expect(v, k).toMatch(/^(\/|[A-Za-z]:\\|[A-Za-z0-9._-]+$|--require )/);
  });

  it("R8 process.report and execArgv hold the preload path and stand-ins only", () => {
    const out = app(`
      const report = JSON.stringify(process.report.getReport());
      console.log(JSON.stringify({ hasStandin: report.includes(${JSON.stringify(STANDIN)}), execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS }));`);
    expect(out.hasStandin).toBe(true);
    expect(String(out.nodeOptions)).toContain("register");
  });

  it("C1 C3 exec, sh and python children see the same stand-in", () => {
    const out = app(`
      const cp = require("child_process");
      console.log(JSON.stringify({
        env: cp.execSync("env").toString().includes(${JSON.stringify(STANDIN)}),
        sh: cp.execSync("sh -c 'printf %s \\"$STRIPE_SECRET_KEY\\"'").toString(),
        py: ${hasPython} ? cp.execSync("python3 -c 'import os;print(os.environ[\\"STRIPE_SECRET_KEY\\"],end=\\"\\")'").toString() : null,
      }));`);
    expect(out.env).toBe(true);
    expect(out.sh).toBe(STANDIN);
    if (hasPython) expect(out.py).toBe(STANDIN);
  });

  it("C2 a forked Node child keeps the preload (NODE_OPTIONS still --require) and the stand-in", () => {
    const out = app(`
      const r = require("child_process").spawnSync(process.execPath, ["-e", "console.log(process.env.STRIPE_SECRET_KEY + '|' + process.env.NODE_OPTIONS)"]);
      console.log(JSON.stringify({ child: r.stdout.toString().trim() }));`);
    const [key, opts] = String(out.child).split("|");
    expect(key).toBe(STANDIN);
    expect(opts).toContain("register");
  });

  it("C5 a detached child that outlives the app gets the same stand-in", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-c5-")), "out.txt");
    const child = `require("fs").writeFileSync(${JSON.stringify(file)}, process.env.STRIPE_SECRET_KEY)`;
    app(`
      require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { detached: true, stdio: "ignore" }).unref();
      console.log("{}");`);
    for (let i = 0; i < 60 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(file, "utf8")).toBe(STANDIN);
  });
});
