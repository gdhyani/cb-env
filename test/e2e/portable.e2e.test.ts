import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor, type RunningApp, runExample } from "./harness/app";
import { type Suite, startSuite } from "./harness/suite";

/**
 * §13 canaries on every OS (M7). Needs no Docker services, so CI runs it on macOS, Windows and Linux: the upstream
 * MongoDB is mongodb-memory-server and the HTTPS provider is a mock on the test CA. Never skipped: there is no
 * service to be missing, so a failure to start is a failure.
 */
const dir = path.resolve(__dirname, "fixtures/portable-app");
const APPS = [
  { name: "ESM", entry: "app.mjs", port: 3121, entryRe: /app\.mjs/ },
  { name: "CJS", entry: "app.cjs", port: 3122, entryRe: /app\.cjs/ },
] as const;

describe("portable canary suite (§13, M7)", () => {
  let suite: Suite;
  const apps: RunningApp[] = [];

  beforeAll(async () => {
    suite = await startSuite("portable", { mongo: true });
    const { canaries: c, mocks } = suite;
    await suite.seed(dir, {
      resources: [
        {
          body: { kind: "mongodb", name: "shop-db", connectionUri: suite.upstreamMongo?.uri },
          vars: [["MONGODB_URI", "url"]],
        },
        {
          body: {
            kind: "http",
            name: "openai",
            upstreamUrl: mocks.url("openai"),
            apiKey: c.openai,
            redirectHosts: ["api.openai.com:443"],
          },
          vars: [["OPENAI_API_KEY", "key"]],
        },
      ],
      plain: { ESM_PORT: String(APPS[0].port), CJS_PORT: String(APPS[1].port) },
    });
    for (const a of APPS)
      apps.push(
        await runExample(suite.cfg, {
          dir,
          command: ["node", a.entry],
          readyUrl: `http://127.0.0.1:${a.port}/health`,
          env: cbEnvFor(suite.cbHome, suite.evidence),
          evidenceDir: suite.evidence,
          logFile: path.join(suite.evidence, "cli.log"),
          appEntry: a.entryRe,
        }),
      );
  });

  afterAll(async () => {
    for (const a of apps) await a.stop().catch(() => undefined);
    await suite?.close();
  });

  for (const [i, a] of APPS.entries())
    for (const route of ["/mongo", "/openai"])
      it(`§13 portable: ${a.name} app reaches ${route.slice(1)} through cb`, async () => {
        const res = await fetch(`http://127.0.0.1:${a.port}${route}`);
        const body = (await res.json()) as { ok: boolean };
        suite.saveResponse(`${a.name}${route.replace("/", "-")}-${i}`, {
          headers: Object.fromEntries(res.headers),
          body,
        });
        expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
      });

  it("§15 the mock upstream received only the real key, never a fake", () => {
    expect(suite.mocks.fakesSeen()).toEqual([]);
    expect(suite.mocks.calls("openai")).toBeGreaterThanOrEqual(APPS.length);
  });

  it("S1/S9 §13 portable canary scan: no real secret in app env/heap, agent heap, CB_HOME, logs or responses", async () => {
    for (const a of apps) await a.dumpEvidence();
    await apps[0].agentHeapSnapshot(path.join(suite.evidence, "agent.heapsnapshot"));
    for (const a of apps) await a.stop();
    const report = await suite.scan();
    expect(report.leaks).toEqual([]);
  });
});
