import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCa, mintTestLeaf, type Pem } from "../helpers/certs";
import { REGISTER, runNode, runNodeAsync, writeSnapshot } from "../helpers/run-node";

const HOST = "api.cbtest.dev";
let ca: Pem;
let probe: { port: number; close(): void };
let echo: { port: number; close(): void };
let snap: string;

beforeAll(async () => {
  ca = await createTestCa();
  const leaf = await mintTestLeaf(ca, HOST);
  const h2 = http2.createSecureServer({ allowHTTP1: true, cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const sock = req.socket as tls.TLSSocket & { servername?: string };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ servername: sock.servername, alpn: sock.alpnProtocol, httpVersion: req.httpVersion }));
  });
  await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
  probe = { port: (h2.address() as AddressInfo).port, close: () => h2.close() };
  const tcp = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  echo = { port: (tcp.address() as AddressInfo).port, close: () => tcp.close() };
  snap = writeSnapshot({
    env: { FOO: "bar" },
    redirects: { [`${HOST}:443`]: probe.port, "db.cbtest.dev:5432": echo.port },
    orgCaCert: ca.certPem,
  });
});
afterAll(() => {
  probe.close();
  echo.close();
});

const cjs = (code: string, env: NodeJS.ProcessEnv = {}) =>
  runNodeAsync(["--require", REGISTER, "-e", code], { CB_SNAPSHOT_PATH: snap, ...env });
const esm = (code: string) =>
  runNodeAsync(["--require", REGISTER, "--input-type=module", "-e", code], { CB_SNAPSHOT_PATH: snap });

describe("preload env + fail closed (FR-REG-001, FR-REG-002)", () => {
  it("FR-REG-001 fails closed outside cb run, with a missing or revoked snapshot", () => {
    expect(runNode(["--require", REGISTER, "-e", "0"]).stderr).toContain('wasn\'t started with "cb run"');
    expect(
      runNode(["--require", REGISTER, "-e", "0"], { CB_SNAPSHOT_PATH: path.join(os.tmpdir(), "nope.json") }).stderr,
    ).toContain("snapshot missing");
    const revoked = runNode(["--require", REGISTER, "-e", "0"], {
      CB_SNAPSHOT_PATH: writeSnapshot({ status: "revoked", revokedReason: "leak" }),
    });
    expect(revoked.status).not.toBe(0);
    expect(revoked.stderr).toContain('access revoked by admin (reason: "leak")');
  });

  it("FR-REG-002 loads env without overriding values cb run already set", async () => {
    expect((await cjs("console.log(process.env.FOO)")).stdout).toBe("bar");
    expect((await cjs("console.log(process.env.FOO)", { FOO: "parent" })).stdout).toBe("parent");
  });
});

const GET = `require('https').get('https://${HOST}/x', r => { let b=''; r.on('data', c => b += c); r.on('end', () => console.log(b)); }).on('error', e => { console.error(e.message); process.exit(3); })`;

describe("preload redirection (FR-REG-003..006, L13, T1)", () => {
  it("https.get reaches the agent port with SNI kept and org CA trusted", async () => {
    const r = await cjs(GET);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toMatchObject({ servername: HOST, httpVersion: "1.1" });
  });

  it("global fetch and ESM named imports are redirected (FR-REG-005)", async () => {
    const fetched = await esm(`const r = await fetch('https://${HOST}/x'); console.log(await r.text());`);
    expect(JSON.parse(fetched.stdout).servername).toBe(HOST);
    const named = await esm(
      `import { get } from 'node:https'; get('https://${HOST}/x', r => { let b=''; r.on('data', c => b += c); r.on('end', () => console.log(b)); });`,
    );
    expect(JSON.parse(named.stdout).servername).toBe(HOST);
  });

  it("http2.connect keeps ALPN h2", async () => {
    const r = await esm(
      `import http2 from 'node:http2'; const c = http2.connect('https://${HOST}'); const q = c.request({':path':'/x'}); let b=''; q.setEncoding('utf8'); q.on('data', d => b += d); q.on('end', () => { console.log(b); c.close(); }); q.end();`,
    );
    expect(JSON.parse(r.stdout)).toMatchObject({ alpn: "h2", httpVersion: "2.0" });
  });

  it("plain net.connect to a redirected host:port is rewritten; other hosts untouched", async () => {
    const redirected = await cjs(
      `const s = require('net').connect(5432, 'db.cbtest.dev', () => s.write('ping')); s.on('data', d => { console.log(d.toString()); s.end(); });`,
    );
    expect(redirected.stdout).toBe("ping");
    const direct = await cjs(
      `const s = require('net').connect(${echo.port}, '127.0.0.1', () => s.write('direct')); s.on('data', d => { console.log(d.toString()); s.end(); });`,
    );
    expect(direct.stdout).toBe("direct");
  });

  it("L13 the org CA is not trusted for non-redirected connections", async () => {
    const r = await cjs(
      `require('tls').connect({ host: '127.0.0.1', port: ${probe.port}, servername: '${HOST}' }, () => console.log('connected')).on('error', () => console.log('rejected'));`,
    );
    expect(r.stdout).toBe("rejected");
  });
});
