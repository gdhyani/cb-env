import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor, cbRunOnce } from "../e2e/harness/app";
import { servicesAvailable } from "../e2e/harness/config";
import { type Suite, startSuite } from "../e2e/harness/suite";
import { percentile } from "./stats";

/** One line of t2-client.mjs output. */
interface Workload {
  workload: "pg" | "redis" | "mongo" | "http" | "sse" | "s3-put" | "s3-get";
  samples: number[];
  bytesPerSec?: number;
}

const APP = path.resolve(__dirname, "t2-app");
const CLIENT = path.join(APP, "client.mjs");
// A benchmark that silently measures nothing is worse than a failure: `npm run bench` needs the compose services.
if (!servicesAvailable())
  throw new Error("T2 needs the compose test services: set CB_TEST_DB_PASSWORD and CB_TEST_REDIS_PASSWORD");

/** Runs the client directly with the real upstream values (the "no cb" baseline). */
function runDirect(env: NodeJS.ProcessEnv): Promise<Workload[]> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cb-t2-")), "direct.json");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT], {
      cwd: APP,
      env: { PATH: process.env.PATH, NODE_OPTIONS: "", T2_OUT: out, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(JSON.parse(fs.readFileSync(out, "utf8")))
        : reject(new Error(`direct client exited ${code}`)),
    );
  });
}

const byName = (ws: Workload[], name: Workload["workload"]) => {
  const w = ws.find((x) => x.workload === name);
  if (!w) throw new Error(`workload ${name} missing`);
  return w;
};

describe("T2 gateway latency (§6, M7)", () => {
  let suite: Suite;
  let directEnv: NodeJS.ProcessEnv;
  let direct: Workload[];
  let viaCb: Workload[];
  const rows: string[] = [];

  beforeAll(async () => {
    suite = await startSuite("t2", { mongo: true });
    const { canaries: c, mocks, services } = suite;
    const s3sdk = createRequire(path.join(APP, "package.json"))("@aws-sdk/client-s3");
    const admin = new s3sdk.S3Client({
      region: "us-east-1",
      endpoint: services.s3.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: services.s3.accessKeyId, secretAccessKey: services.s3.secretAccessKey },
    });
    await admin.send(new s3sdk.CreateBucketCommand({ Bucket: "cb-t2-bench" })).catch((e: { name?: string }) => {
      if (!/BucketAlready/.test(e.name ?? "")) throw e;
    });
    await suite.seed(APP, {
      resources: [
        { body: { kind: "postgres", name: "db", connectionUri: services.pg }, vars: [["DATABASE_URL", "url"]] },
        { body: { kind: "redis", name: "cache", connectionUri: services.redis }, vars: [["REDIS_URL", "url"]] },
        {
          body: { kind: "mongodb", name: "docs", connectionUri: suite.upstreamMongo?.uri },
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
        {
          body: { kind: "aws", name: "uploads", region: "us-east-1", ...services.s3 },
          vars: [
            ["AWS_ACCESS_KEY_ID", "accessKeyId"],
            ["AWS_SECRET_ACCESS_KEY", "secretAccessKey"],
            ["S3_ENDPOINT", "endpoint"],
            ["AWS_REGION", "region"],
          ],
        },
      ],
    });
    directEnv = {
      DATABASE_URL: services.pg,
      REDIS_URL: services.redis,
      MONGODB_URI: suite.upstreamMongo?.uri,
      OPENAI_API_KEY: c.openai,
      OPENAI_BASE_URL: mocks.url("openai"),
      // Test-only: the mock upstreams use the run's test CA (the cb path trusts it in the gateway, S11).
      NODE_EXTRA_CA_CERTS: path.join(suite.evidence, "tls", "ca.pem"),
      AWS_ACCESS_KEY_ID: services.s3.accessKeyId,
      AWS_SECRET_ACCESS_KEY: services.s3.secretAccessKey,
      AWS_REGION: "us-east-1",
      S3_ENDPOINT: services.s3.endpoint,
    };
  });

  afterAll(async () => {
    if (rows.length) {
      const file = path.join(suite.cfg.evidenceRoot, `t2-${Date.now()}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `| Workload | direct p50 | direct p95 | cb p50 | cb p95 | added p50 | added p95 | pass |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`,
      );
      console.log(`T2 table: ${file}\n${fs.readFileSync(file, "utf8")}`);
    }
    await suite?.close();
  });

  it("T2 percentiles ignore warm-up samples", async () => {
    const short = await runDirect({ ...directEnv, T2_ITERATIONS: "10", T2_WARMUP: "5", T2_S3_ITERATIONS: "1" });
    for (const w of short.filter((x) => !x.workload.startsWith("s3"))) expect(w.samples, w.workload).toHaveLength(10);
  });

  it("T2 runs every workload directly and through cb", async () => {
    direct = await runDirect(directEnv);
    const out = path.join(suite.evidence, "t2-cb.json");
    await cbRunOnce(suite.cfg, {
      dir: APP,
      command: ["node", CLIENT],
      // No evidence hook here: it would add its own work to the cb side of the comparison.
      env: cbEnvFor(suite.cbHome, suite.evidence, { NODE_OPTIONS: "", T2_OUT: out }),
      logFile: path.join(suite.evidence, "cli.log"),
    });
    viaCb = JSON.parse(fs.readFileSync(out, "utf8"));
    // The cb run really went through cb: every driver used an agent listener and the app held a stand-in key.
    const targets = JSON.parse(fs.readFileSync(`${out}.targets.json`, "utf8")) as Record<string, string>;
    for (const key of ["DATABASE_URL", "REDIS_URL", "MONGODB_URI", "S3_ENDPOINT"]) {
      const [host, port] = targets[key].split(":");
      expect(host, key).toBe("127.0.0.1");
      expect(Number(port), key).toBeGreaterThanOrEqual(7400);
      expect(Number(port), key).toBeLessThanOrEqual(7999);
    }
    expect(targets.openaiKeySha256).not.toBe(createHash("sha256").update(suite.canaries.openai).digest("hex"));
    expect(suite.mocks.fakesSeen()).toEqual([]);
    expect(viaCb.map((w) => w.workload).sort()).toEqual(direct.map((w) => w.workload).sort());
  });

  for (const name of ["pg", "redis", "mongo", "http"] as const) {
    it(`T2 ${name} added overhead p50 ≤ 3 ms and p95 ≤ 10 ms`, () => {
      const d = byName(direct, name).samples;
      const v = byName(viaCb, name).samples;
      const add50 = percentile(v, 50) - percentile(d, 50);
      const add95 = percentile(v, 95) - percentile(d, 95);
      const pass = add50 <= 3 && add95 <= 10;
      rows.push(
        `| ${name} | ${[percentile(d, 50), percentile(d, 95), percentile(v, 50), percentile(v, 95), add50, add95].map((n) => n.toFixed(2)).join(" | ")} | ${pass ? "✅" : "❌"} |`,
      );
      expect(add50).toBeLessThanOrEqual(3);
      expect(add95).toBeLessThanOrEqual(10);
    });
  }

  it("T2 SSE first byte ≤ 1 RTT + 5 ms", () => {
    // One round trip to a local service: the direct Redis GET median.
    const rtt = percentile(byName(direct, "redis").samples, 50);
    const d = percentile(byName(direct, "sse").samples, 50);
    const v = percentile(byName(viaCb, "sse").samples, 50);
    rows.push(
      `| sse first byte | ${d.toFixed(2)} | – | ${v.toFixed(2)} | – | ${(v - d).toFixed(2)} | – | ${v - d <= rtt + 5 ? "✅" : "❌"} (limit ${(rtt + 5).toFixed(2)}) |`,
    );
    expect(v - d).toBeLessThanOrEqual(rtt + 5);
  });

  for (const name of ["s3-put", "s3-get"] as const) {
    it(`T2 50 MB ${name} throughput within 15% of direct`, () => {
      const d = byName(direct, name).bytesPerSec ?? 0;
      const v = byName(viaCb, name).bytesPerSec ?? 0;
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB/s`;
      rows.push(
        `| ${name} 50 MB | ${mb(d)} | – | ${mb(v)} | – | ${((1 - v / d) * 100).toFixed(1)}% slower | – | ${v >= 0.85 * d ? "✅" : "❌"} |`,
      );
      expect(v).toBeGreaterThanOrEqual(0.85 * d);
    });
  }
});
