import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTER, runNodeAsync, writeSnapshot } from "../helpers/run-node";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-listen-")), "listen.jsonl");
const records = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { pid: number; port: number; http: boolean; explicit: boolean });

describe("FR-WH-003 the preload reports the ports the app listens on (no port setting anywhere)", () => {
  it("records http servers with an explicit port, marks listen(0) and plain TCP servers, CJS", async () => {
    const file = tmpFile();
    const snap = writeSnapshot({ env: {} });
    const code = `
      const http = require("node:http"); const net = require("node:net");
      const a = http.createServer(); const b = http.createServer(); const c = net.createServer();
      b.listen(0, "127.0.0.1", () => {
        const explicit = b.address().port;
        b.close(() => a.listen(explicit, "127.0.0.1", () => c.listen(0, () => {
          console.log(explicit); a.close(); c.close();
        })));
      });`;
    const r = await runNodeAsync(["--require", REGISTER, "-e", code], { CB_SNAPSHOT_PATH: snap, CB_LISTEN_FILE: file });
    expect(r.stderr).toBe("");
    const port = Number(r.stdout);
    const got = records(file);
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({ http: true, explicit: false });
    expect(got[1]).toMatchObject({ http: true, explicit: true, port });
    expect(got[2]).toMatchObject({ http: false, explicit: false });
    expect(got[1]?.pid).toBeGreaterThan(0);
  });

  it("works for ESM apps and option-object listen calls, and never breaks the app when the file can't be written", async () => {
    const file = tmpFile();
    const snap = writeSnapshot({ env: {} });
    const code = `
      import http from "node:http";
      const s = http.createServer();
      const probe = http.createServer().listen(0, () => { const p = probe.address().port; probe.close(() =>
        s.listen({ port: p, host: "127.0.0.1" }, () => { console.log(p); s.close(); })); });`;
    const r = await runNodeAsync(["--require", REGISTER, "--input-type=module", "-e", code], {
      CB_SNAPSHOT_PATH: snap,
      CB_LISTEN_FILE: file,
    });
    expect(records(file).at(-1)).toMatchObject({ http: true, explicit: true, port: Number(r.stdout) });

    const broken = await runNodeAsync(
      [
        "--require",
        REGISTER,
        "-e",
        'require("node:http").createServer().listen(0, function () { console.log("up"); this.close(); })',
      ],
      { CB_SNAPSHOT_PATH: snap, CB_LISTEN_FILE: path.join(os.tmpdir(), "no-such-dir-cb", "x", "listen.jsonl") },
    );
    expect(broken.stdout).toBe("up");
    expect(broken.stderr).toBe("");
  });

  it("counts HTTP/2 servers as web servers", async () => {
    const file = tmpFile();
    const snap = writeSnapshot({ env: {} });
    const code = `
      const http2 = require("node:http2");
      const s = http2.createServer((q, r) => r.end());
      s.listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });`;
    const r = await runNodeAsync(["--require", REGISTER, "-e", code], { CB_SNAPSHOT_PATH: snap, CB_LISTEN_FILE: file });
    expect(records(file)[0]).toMatchObject({ http: true, port: Number(r.stdout) });
  });

  it("does nothing without CB_LISTEN_FILE", async () => {
    const snap = writeSnapshot({ env: {} });
    const r = await runNodeAsync(
      [
        "--require",
        REGISTER,
        "-e",
        'require("node:http").createServer().listen(0, function () { console.log("up"); this.close(); })',
      ],
      { CB_SNAPSHOT_PATH: snap },
    );
    expect(r.stdout).toBe("up");
  });
});
