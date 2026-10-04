import { generateKeyPairSync, randomBytes } from "node:crypto";

const tag = (name: string) => `CANARY_${name}_${randomBytes(12).toString("hex")}`;

/** Unique per run; the mock upstreams accept only these, and the scanner fails on any trace of them. */
export function makeCanaries() {
  const google = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const apns = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    stripe: `sk_test_${tag("stripe")}`,
    openai: `sk-${tag("openai")}`,
    anthropic: `sk-ant-${tag("anthropic")}`,
    razorpaySecret: tag("razorpay"),
    googleClientSecret: tag("google"),
    awsAccessKeyId: `AKIA${randomBytes(8).toString("hex").toUpperCase()}`,
    awsSecretAccessKey: tag("aws"),
    mongoPassword: tag("mongo"),
    googleAccessToken: `ya29.${tag("gtoken")}`,
    /** Private keys: real material for google-sa/apns; their public halves verify at the mock. */
    googlePrivateKey: google.privateKey,
    googlePublicKey: google.publicKey,
    apnsPrivateKey: apns.privateKey,
    apnsPublicKey: apns.publicKey,
  };
}
export type Canaries = ReturnType<typeof makeCanaries>;

/** Base64 body line of a PEM: what must never appear anywhere (headers like BEGIN PRIVATE KEY are public). */
const pemBody = (pem: string) => pem.split("\n").filter((l) => l && !l.startsWith("-----"))[1] ?? "";

/** Every secret value the scanner looks for (private keys by a body line, public keys excluded). */
export function secretsOf(c: Canaries, extra: (string | undefined)[] = []): string[] {
  const { googlePublicKey: _gp, apnsPublicKey: _ap, googlePrivateKey, apnsPrivateKey, ...plain } = c;
  return [...Object.values(plain), pemBody(googlePrivateKey), pemBody(apnsPrivateKey), ...extra].filter(
    (v): v is string => Boolean(v),
  );
}
