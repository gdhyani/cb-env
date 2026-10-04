import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor, type RunningApp, runExample } from "./harness/app";
import { servicesAvailable } from "./harness/config";
import { type Suite, startSuite } from "./harness/suite";

const dir = path.resolve(__dirname, "../../examples/nest-mysql");
const PORT = 3200;
const base = `http://127.0.0.1:${PORT}`;

describe.skipIf(!servicesAvailable())("examples/nest-mysql under cb run (§15, §13)", () => {
  let suite: Suite;
  let app: RunningApp;

  beforeAll(async () => {
    suite = await startSuite("nest-mysql");
    const { canaries: c, mocks, services } = suite;
    await suite.seed(dir, {
      resources: [
        { body: { kind: "mysql", name: "legacy-db", connectionUri: services.mysql }, vars: [["DATABASE_URL", "url"]] },
        {
          body: {
            kind: "http",
            name: "anthropic",
            upstreamUrl: mocks.url("anthropic"),
            authScheme: "x-api-key",
            apiKey: c.anthropic,
            redirectHosts: ["api.anthropic.com:443"],
          },
          vars: [["ANTHROPIC_API_KEY", "key"]],
        },
        {
          body: {
            kind: "aws",
            name: "queue",
            region: "us-east-1",
            endpoint: mocks.url("aws"),
            accessKeyId: c.awsAccessKeyId,
            secretAccessKey: c.awsSecretAccessKey,
          },
          vars: [
            ["AWS_ACCESS_KEY_ID", "accessKeyId"],
            ["AWS_SECRET_ACCESS_KEY", "secretAccessKey"],
            ["SQS_ENDPOINT", "endpoint"],
            ["AWS_REGION", "region"],
          ],
        },
      ],
      plain: { PORT: String(PORT) },
    });
    app = await runExample(suite.cfg, {
      dir,
      command: ["npm", "run", "dev"],
      readyUrl: `${base}/health`,
      env: cbEnvFor(suite.cbHome, suite.evidence),
      evidenceDir: suite.evidence,
      logFile: path.join(suite.evidence, "cli.log"),
      appEntry: /dist[\\/]main\.js/,
    });
  });

  afterAll(async () => {
    await app?.stop().catch(() => undefined);
    await suite?.close();
  });

  it.each(["/config", "/mysql", "/anthropic", "/sqs"])(
    "T4/§15 %s works through cb with the official SDK",
    async (route) => {
      const res = await fetch(`${base}${route}`);
      const body = await res.json();
      suite.saveResponse(route.slice(1), { headers: Object.fromEntries(res.headers), body });
      expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
    },
  );

  it("§15 @nestjs/config sees the fake key (non-empty), never the real one", async () => {
    const body = await (await fetch(`${base}/config`)).json();
    expect(body.result.anthropicKeyLength).toBeGreaterThan(0);
  });

  it("§15 mock upstreams received only real secrets, never a fake", () => {
    expect(suite.mocks.fakesSeen()).toEqual([]);
    for (const p of ["anthropic", "aws"] as const) expect(suite.mocks.calls(p), p).toBeGreaterThan(0);
  });

  it("S1/S9 §13 canary suite: no real secret in app env/heap, agent heap, CB_HOME, logs or responses", async () => {
    await app.dumpEvidence();
    await app.agentHeapSnapshot(path.join(suite.evidence, "agent.heapsnapshot"));
    await app.stop();
    const report = await suite.scan();
    expect(report.leaks).toEqual([]);
  });
});
