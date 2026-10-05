// A plain Express app: official SDKs configured only from process.env. Nothing here knows about cb.
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESClient } from "@aws-sdk/client-ses";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import apn from "@parse/node-apn";
import express from "express";
import { applicationDefault, cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { Redis } from "ioredis";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import Razorpay from "razorpay";

const env = process.env;
await mongoose.connect(env.MONGODB_URI);
const Order = mongoose.model("Order", new mongoose.Schema({ sku: String, qty: Number }));
const redis = new Redis(env.REDIS_URL);
const razorpay = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
const s3 = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});
const ses = new SESClient({
  region: env.SES_REGION,
  endpoint: env.SES_ENDPOINT,
  credentials: { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY },
});
const mailer = nodemailer.createTransport(env.SMTP_URL);
const firebase = initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT)) });
const apns = new apn.Provider({
  token: { key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID },
  production: false,
});

const app = express();
const route = (path, fn) =>
  app.get(path, async (_req, res) => {
    try {
      res.json({ ok: true, result: await fn() });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) });
    }
  });

route("/health", async () => "up");
route("/mongo", async () => {
  await Order.create({ sku: "A1", qty: 2 });
  return Order.findOne({ sku: "A1" }).lean();
});
route("/redis", async () => {
  await redis.set("greeting", "hello");
  return redis.get("greeting");
});
route("/razorpay", () => razorpay.orders.create({ amount: 500, currency: "INR" }));
route("/s3", async () => {
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: "hello.txt", Body: "hi" }));
  const object = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: "hello.txt" }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: "hello.txt" }), {
    expiresIn: 60,
  });
  return { got: await object.Body.transformToString(), presigned: await (await fetch(url)).text() };
});
route("/ses", async () => {
  const sent = await ses.send(
    new SendEmailCommand({
      Source: "shop@example.test",
      Destination: { ToAddresses: ["a@example.test"] },
      Message: { Subject: { Data: "hi" }, Body: { Text: { Data: "hi" } } },
    }),
  );
  return { messageId: sent.MessageId };
});
route("/mail", async () => {
  const info = await mailer.sendMail({ from: "shop@example.test", to: "a@example.test", subject: "hi", text: "hi" });
  return { accepted: info.accepted };
});
// The other common setup: the SDK finds the key file itself through GOOGLE_APPLICATION_CREDENTIALS.
const firebaseFromFile = initializeApp({ credential: applicationDefault() }, "from-file");
route("/fcm-file", () =>
  getMessaging(firebaseFromFile).send({ token: "device-token-e2e", notification: { title: "from file" } }),
);
route("/fcm", () => getMessaging(firebase).send({ token: "device-token-e2e", notification: { title: "hi" } }));
route("/apns", async () => {
  const note = new apn.Notification({ alert: "hi", topic: "test.shop" });
  const r = await apns.send(note, "a".repeat(64));
  return { sent: r.sent.length, failed: r.failed.length };
});
route("/leak", async () => {
  const res = await fetch(`${env.LEAK_BASE_URL}/echo`, { headers: { authorization: `Bearer ${env.LEAK_API_KEY}` } });
  return res.text();
});

// Razorpay webhooks, verified the usual way with the official SDK and the env var — cb delivers them re-signed for
// this device, so this code is exactly what runs in production.
const received = [];
app.post("/webhooks/razorpay", express.raw({ type: "*/*" }), (req, res) => {
  const verified = Razorpay.validateWebhookSignature(
    req.body.toString("utf8"),
    req.header("x-razorpay-signature") ?? "",
    env.RAZORPAY_WEBHOOK_SECRET,
  );
  received.push({ verified, event: JSON.parse(req.body.toString("utf8")).event, id: req.header("x-razorpay-event-id") });
  res.status(verified ? 200 : 400).end();
});
route("/webhooks/received", async () => received);

app.listen(Number(env.PORT ?? 3100), "127.0.0.1", () => console.log(`express-mongo on :${env.PORT ?? 3100}`));
