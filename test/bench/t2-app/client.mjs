// T2 benchmark client (M7, PRD §6). Reads its targets only from the environment, so the same file runs
// directly (real URLs) and under `cb run` (stand-ins + local listeners). Writes one JSON array to T2_OUT.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { MongoClient } from "mongodb";
import pg from "pg";

const N = Number(process.env.T2_ITERATIONS ?? 500);
const WARMUP = Number(process.env.T2_WARMUP ?? 50);
const S3_N = Number(process.env.T2_S3_ITERATIONS ?? 5);
const S3_BYTES = 50 * 1024 * 1024;

async function timed(fn) {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await fn();
    samples.push(performance.now() - t);
  }
  return samples;
}

const results = [];

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
results.push({ workload: "pg", samples: await timed(() => db.query("SELECT 1")) });
await db.end();

const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
await redis.connect();
await redis.set("cb:t2:key", "value");
results.push({ workload: "redis", samples: await timed(() => redis.get("cb:t2:key")) });
await redis.del("cb:t2:key");
redis.disconnect();

const mongo = new MongoClient(process.env.MONGODB_URI);
await mongo.connect();
const docs = mongo.db().collection("t2");
const { insertedId } = await docs.insertOne({ n: 1 });
results.push({ workload: "mongo", samples: await timed(() => docs.findOne({ _id: insertedId })) });
await docs.deleteOne({ _id: insertedId });
await mongo.close();

const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
const chat = () =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-e2e", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
results.push({
  workload: "http",
  samples: await timed(async () => {
    const res = await chat();
    if (!res.ok) throw new Error(`http ${res.status}`);
    await res.text();
  }),
});
const firstByte = [];
for (let i = 0; i < WARMUP + N; i++) {
  const t = performance.now();
  const res = await chat();
  const reader = res.body.getReader();
  await reader.read();
  if (i >= WARMUP) firstByte.push(performance.now() - t);
  await reader.cancel();
}
results.push({ workload: "sse", samples: firstByte });

const s3 = new S3Client({ region: process.env.AWS_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true });
const body = Buffer.alloc(S3_BYTES, 7);
const put = [];
const get = [];
for (let i = 0; i < S3_N + 1; i++) {
  let t = performance.now();
  await s3.send(new PutObjectCommand({ Bucket: "cb-t2-bench", Key: "t2.bin", Body: body }));
  const p = performance.now() - t;
  t = performance.now();
  const obj = await s3.send(new GetObjectCommand({ Bucket: "cb-t2-bench", Key: "t2.bin" }));
  const bytes = (await obj.Body.transformToByteArray()).length;
  const g = performance.now() - t;
  if (bytes !== S3_BYTES) throw new Error(`s3 get returned ${bytes} bytes`);
  if (i > 0) {
    put.push(p);
    get.push(g);
  }
}
const rate = (ms) => (S3_BYTES * ms.length) / (ms.reduce((a, b) => a + b, 0) / 1000);
results.push({ workload: "s3-put", samples: put, bytesPerSec: rate(put) });
results.push({ workload: "s3-get", samples: get, bytesPerSec: rate(get) });

// Where each workload went (host:port only, never credentials) and a hash of the API key, so the harness can prove
// the cb run used the agent's listeners and a stand-in key.
const hostOf = (u) => new URL(u).host;
const targets = {
  DATABASE_URL: hostOf(process.env.DATABASE_URL),
  REDIS_URL: hostOf(process.env.REDIS_URL),
  MONGODB_URI: hostOf(process.env.MONGODB_URI),
  S3_ENDPOINT: hostOf(process.env.S3_ENDPOINT),
  openaiKeySha256: createHash("sha256")
    .update(process.env.OPENAI_API_KEY ?? "")
    .digest("hex"),
};
fs.writeFileSync(`${process.env.T2_OUT}.targets.json`, JSON.stringify(targets));
fs.writeFileSync(process.env.T2_OUT, JSON.stringify(results));
