import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor, type RunningApp, runExample } from "./harness/app";
import { servicesAvailable } from "./harness/config";
import { type Suite, startSuite } from "./harness/suite";

const dir = path.resolve(__dirname, "../../examples/express-mongo");
const PORT = 3100;
const base = `http://127.0.0.1:${PORT}`;
const ROUTES = ["/mongo", "/redis", "/razorpay", "/s3", "/ses", "/mail", "/fcm", "/fcm-file", "/apns"];

describe.skipIf(!servicesAvailable())("examples/express-mongo under cb run (§15, §13)", () => {
  let suite: Suite;
  let app: RunningApp;

  beforeAll(async () => {
    suite = await startSuite("express-mongo", { mongo: true });
    const { canaries: c, mocks, services } = suite;
    // The bucket is created harness-side with the real credentials; the app never sees them.
    const s3sdk = createRequire(path.join(dir, "package.json"))("@aws-sdk/client-s3");
    const admin = new s3sdk.S3Client({
      region: "us-east-1",
      endpoint: services.s3.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: services.s3.accessKeyId, secretAccessKey: services.s3.secretAccessKey },
    });
    await admin.send(new s3sdk.CreateBucketCommand({ Bucket: "e2e" })).catch((e: { name?: string }) => {
      if (!/BucketAlready/.test(e.name ?? "")) throw e;
    });
    await suite.seed(dir, {
      resources: [
        {
          body: { kind: "mongodb", name: "shop-db", connectionUri: suite.upstreamMongo?.uri },
          vars: [["MONGODB_URI", "url"]],
        },
        { body: { kind: "redis", name: "cache", connectionUri: services.redis }, vars: [["REDIS_URL", "url"]] },
        {
          body: {
            kind: "webhook",
            name: "razorpay-webhooks",
            provider: "razorpay",
            path: "/webhooks/razorpay",
            signingSecret: c.razorpayWebhookSecret,
          },
          vars: [["RAZORPAY_WEBHOOK_SECRET", "secret"]],
        },
        {
          body: {
            kind: "http",
            name: "razorpay",
            provider: "razorpay",
            upstreamUrl: mocks.url("razorpay"),
            authScheme: "basic-password",
            apiKey: c.razorpaySecret,
            redirectHosts: ["api.razorpay.com:443"],
          },
          vars: [["RAZORPAY_KEY_SECRET", "key"]],
        },
        {
          body: { kind: "aws", name: "uploads", region: "us-east-1", ...services.s3 },
          vars: [
            ["AWS_ACCESS_KEY_ID", "accessKeyId"],
            ["AWS_SECRET_ACCESS_KEY", "secretAccessKey"],
            ["S3_ENDPOINT", "endpoint"],
            ["AWS_REGION", "region"],
          ],
        },
        {
          body: {
            kind: "aws",
            name: "mailer-ses",
            region: "us-east-1",
            endpoint: mocks.url("aws"),
            accessKeyId: c.awsAccessKeyId,
            secretAccessKey: c.awsSecretAccessKey,
          },
          vars: [
            ["SES_ACCESS_KEY_ID", "accessKeyId"],
            ["SES_SECRET_ACCESS_KEY", "secretAccessKey"],
            ["SES_ENDPOINT", "endpoint"],
            ["SES_REGION", "region"],
          ],
        },
        { body: { kind: "smtp", name: "mailer", connectionUri: services.smtp }, vars: [["SMTP_URL", "url"]] },
        {
          body: {
            kind: "google-sa",
            name: "firebase",
            upstreamUrl: mocks.url("push"),
            serviceAccountJson: JSON.stringify({
              type: "service_account",
              project_id: "cb-e2e-shop",
              private_key_id: "e2e0000000000000000000000000000000000001",
              private_key: c.googlePrivateKey,
              client_email: "firebase-adminsdk@cb-e2e-shop.iam.gserviceaccount.com",
              token_uri: "https://oauth2.googleapis.com/token",
            }),
          },
          vars: [
            ["FIREBASE_SERVICE_ACCOUNT", "credentialsJson"],
            ["GOOGLE_APPLICATION_CREDENTIALS", "credentialsFile"],
          ],
        },
        {
          body: {
            kind: "apns",
            name: "apple-push",
            keyId: "E2EKEY0001",
            teamId: "E2ETEAM001",
            privateKey: c.apnsPrivateKey,
            upstreamUrl: mocks.url("push"),
          },
          vars: [
            ["APNS_KEY", "key"],
            ["APNS_KEY_ID", "keyId"],
            ["APNS_TEAM_ID", "teamId"],
          ],
        },
        {
          body: { kind: "http", name: "leaky-provider", upstreamUrl: mocks.url("leak"), apiKey: c.stripe },
          vars: [
            ["LEAK_API_KEY", "key"],
            ["LEAK_BASE_URL", "baseUrl"],
          ],
        },
      ],
      plain: { PORT: String(PORT), S3_BUCKET: "e2e", RAZORPAY_KEY_ID: "rzp_test_e2e_public_id" },
    });
    app = await runExample(suite.cfg, {
      dir,
      command: ["npm", "run", "dev"],
      readyUrl: `${base}/health`,
      env: cbEnvFor(suite.cbHome, suite.evidence),
      evidenceDir: suite.evidence,
      logFile: path.join(suite.evidence, "cli.log"),
      appEntry: /src[\\/]server\.js/,
    });
  });

  afterAll(async () => {
    await app?.stop().catch(() => undefined);
    await suite?.close();
  });

  it.each(ROUTES)("T4/§15 %s works through cb with the official SDK", async (route) => {
    const res = await fetch(`${base}${route}`);
    const body = await res.json();
    suite.saveResponse(route.slice(1), { headers: Object.fromEntries(res.headers), body });
    expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
    // APNs reports per-device results instead of throwing: a failed send must not look like success.
    if (route === "/apns") expect(body.result).toEqual({ sent: 1, failed: 0 });
  });

  it("FR-WH-001..003 a Razorpay webhook for the order this app created reaches it, verified by the SDK with its fake", async () => {
    const order = (await (await fetch(`${base}/razorpay`)).json()) as { result: { id: string } };
    await new Promise((r) => setTimeout(r, 300)); // the gateway records the order's owner off the response path
    const body = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_E2eCaptured01", order_id: order.result.id, amount: 500 } } },
    });
    const seeded = suite.seeded;
    if (!seeded) throw new Error("not seeded");
    const res = await fetch(`${seeded.api}/api/hooks/${seeded.resourceIds["razorpay-webhooks"]}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-event-id": "E2eRzpEvent0001",
        "x-razorpay-signature": createHmac("sha256", suite.canaries.razorpayWebhookSecret).update(body).digest("hex"),
      },
      body,
    });
    expect(res.status).toBe(200);
    let received: { verified: boolean; event: string; id: string }[] = [];
    for (let i = 0; i < 100 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      received = ((await (await fetch(`${base}/webhooks/received`)).json()) as { result: typeof received }).result;
    }
    suite.saveResponse("webhooks-received", received);
    expect(received).toEqual([{ verified: true, event: "payment.captured", id: "E2eRzpEvent0001" }]);
  });

  it("FR-GW-006 a provider echoing the real key is redacted before the app sees it", async () => {
    const res = await fetch(`${base}/leak`);
    const text = await res.text();
    suite.saveResponse("leak", text);
    expect(res.status).toBe(200);
    expect(text).not.toContain(suite.canaries.stripe);
  });

  it("§15 mock upstreams received only real secrets, never a fake", () => {
    expect(suite.mocks.fakesSeen()).toEqual([]);
    for (const p of ["razorpay", "aws", "push", "leak"] as const) expect(suite.mocks.calls(p), p).toBeGreaterThan(0);
  });

  it("S1/S9 §13 canary suite: no real secret in app env/heap, agent heap, CB_HOME, logs or responses", async () => {
    await app.dumpEvidence();
    await app.agentHeapSnapshot(path.join(suite.evidence, "agent.heapsnapshot"));
    await app.stop();
    const report = await suite.scan();
    expect(report.leaks).toEqual([]);
  });
});
