import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWebhookPort } from "../../src/cli/commands/run";
import { pickAppPort, watchListenFile } from "../../src/shared/listen-file";

describe("FR-WH-003 which port cb run delivers webhooks to", () => {
  it("--webhook-port wins, then project.json webhookPort, then PORT the app sees", () => {
    expect(resolveWebhookPort("4100", 3060, { PORT: "8080" })).toBe(4100);
    expect(resolveWebhookPort(undefined, 3060, { PORT: "8080" })).toBe(3060);
    expect(resolveWebhookPort(undefined, undefined, { PORT: "8080" })).toBe(8080);
    expect(resolveWebhookPort(undefined, undefined, {})).toBeUndefined();
  });

  it("ignores a PORT that is not a port, and refuses a bad flag clearly", () => {
    expect(resolveWebhookPort(undefined, undefined, { PORT: "abc" })).toBeUndefined();
    expect(resolveWebhookPort(undefined, undefined, { PORT: "70000" })).toBeUndefined();
    expect(() => resolveWebhookPort("nope", undefined, {})).toThrow(/--webhook-port must be a port number/);
  });
});

describe("FR-WH-003 the app's real port, detected from what it listens on", () => {
  const rec = (pid: number, port: number, http = true, explicit = true) => ({ pid, port, http, explicit });

  it("picks the first explicit http server of the newest process that opened one", async () => {
    expect(pickAppPort([])).toBeUndefined();
    expect(pickAppPort([rec(10, 3000)])).toBe(3000);
    // Next.js dev: the server on 3000 plus internal servers on random ports (listen(0)).
    expect(pickAppPort([rec(10, 3000), rec(11, 52011, true, false), rec(10, 52012, false, false)])).toBe(3000);
    // Same process, a second server (metrics) later: the app's first one stays.
    expect(pickAppPort([rec(10, 4000), rec(10, 9100)])).toBe(4000);
    // nodemon restarted the app on a new port: the newest process wins.
    expect(pickAppPort([rec(10, 4000), rec(12, 4100)])).toBe(4100);
    // Only an http server on a random port: still better than guessing.
    expect(pickAppPort([rec(10, 52013, false, false), rec(10, 52014, true, false)])).toBe(52014);
    // Two apps under one cb run (concurrently api web): the one on PORT wins, whichever listened last.
    expect(pickAppPort([rec(10, 4000), rec(11, 3000)], 4000)).toBe(4000);
    expect(pickAppPort([rec(10, 4000), rec(11, 3000)], 5000)).toBe(3000);
    // Plain TCP servers alone are not the app.
    expect(pickAppPort([rec(10, 6000, false, true)])).toBeUndefined();
  });

  it("watches the file and reports each new port once", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-lw-")), "l.jsonl");
    const seen: number[] = [];
    const w = watchListenFile(file, (p) => seen.push(p), 20);
    const add = (r: object) => fs.appendFileSync(file, `${JSON.stringify(r)}\n`);
    const until = async (ok: () => boolean) => {
      const end = Date.now() + 3000;
      while (!ok()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    add(rec(10, 3000));
    await until(() => seen.length === 1);
    add(rec(10, 9100)); // same app, second server: no change
    add(rec(13, 3001)); // restarted on 3001
    await until(() => seen.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([3000, 3001]);
    w.close();
    expect(fs.existsSync(file)).toBe(false); // cleaned up
  });
});
