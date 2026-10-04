import { createHash, createVerify, randomUUID } from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import type { Canaries } from "./canaries";

export type Provider = "stripe" | "openai" | "anthropic" | "razorpay" | "google-oauth" | "aws" | "push" | "leak";
const PROVIDERS: Provider[] = ["stripe", "openai", "anthropic", "razorpay", "google-oauth", "aws", "push", "leak"];

type Req = http2.Http2ServerRequest;
type Res = http2.Http2ServerResponse;

function verifyJwt(token: string, alg: "RS256" | "ES256", publicKey: string) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  if (header.alg !== alg) return null;
  const ok = createVerify("SHA256")
    .update(`${h}.${p}`)
    .verify(
      { key: publicKey, ...(alg === "ES256" ? { dsaEncoding: "ieee-p1363" as const } : {}) },
      Buffer.from(s, "base64url"),
    );
  return ok ? { header, payload: JSON.parse(Buffer.from(p, "base64url").toString()) } : null;
}

/**
 * §15 mock HTTPS upstreams on the test CA, one origin per provider. Each accepts only the run's canary real secret,
 * records anything else it was shown (a fake reaching an upstream is a failure) and answers with the minimal shape
 * the official SDK parses.
 */
export async function startMockUpstreams(c: Canaries, tls: { certPem: string; keyPem: string }) {
  const fakes: string[] = [];
  const counts = new Map<Provider, number>();
  const json = (res: Res, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const deny = (res: Res, presented: string) => {
    fakes.push(presented);
    json(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
  };
  const bearer = (req: Req) => String(req.headers.authorization ?? "").replace(/^Bearer /i, "");

  const handlers: Record<Provider, (req: Req, res: Res, body: string) => void> = {
    stripe(req, res, body) {
      if (bearer(req) !== c.stripe) return deny(res, bearer(req));
      if (req.method === "POST" && req.url === "/v1/payment_intents") {
        const form = new URLSearchParams(body);
        return json(res, 200, {
          id: "pi_e2e",
          object: "payment_intent",
          amount: Number(form.get("amount")),
          currency: form.get("currency"),
          status: "requires_payment_method",
          client_secret: "pi_e2e_secret_public",
        });
      }
      json(res, 404, { error: { message: `no route ${req.url}` } });
    },
    openai(req, res) {
      if (bearer(req) !== c.openai) return deny(res, bearer(req));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const word of ["hello", " from", " e2e"])
        res.write(
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-e2e", choices: [{ index: 0, delta: { content: word }, finish_reason: null }] })}\n\n`,
        );
      res.end("data: [DONE]\n\n");
    },
    anthropic(req, res) {
      const key = String(req.headers["x-api-key"] ?? "");
      if (key !== c.anthropic) return deny(res, key);
      json(res, 200, {
        id: "msg_e2e",
        type: "message",
        role: "assistant",
        model: "claude-e2e",
        content: [{ type: "text", text: "hi from e2e" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 3 },
      });
    },
    razorpay(req, res, body) {
      const [, secret] = Buffer.from(String(req.headers.authorization ?? "").replace(/^Basic /, ""), "base64")
        .toString()
        .split(":");
      if (secret !== c.razorpaySecret) return deny(res, secret ?? "");
      json(res, 200, {
        id: "order_e2e",
        entity: "order",
        amount: JSON.parse(body || "{}").amount,
        currency: "INR",
        status: "created",
      });
    },
    "google-oauth"(_req, res, body) {
      const secret = new URLSearchParams(body).get("client_secret") ?? "";
      if (secret !== c.googleClientSecret) return deny(res, secret);
      json(res, 200, {
        access_token: "ya29.e2e-public-user-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid",
      });
    },
    aws(req, res, body) {
      // SigV4 re-signed by the gateway: the credential scope must name the real (canary) access key id.
      const auth = String(req.headers.authorization ?? "");
      const akid = /Credential=([A-Z0-9]+)\//.exec(auth)?.[1] ?? "";
      if (akid !== c.awsAccessKeyId) return deny(res, akid);
      const service = /Credential=[^/]+\/[^/]+\/[^/]+\/([^/]+)\//.exec(auth)?.[1];
      if (service === "sqs") {
        const msg = JSON.parse(body || "{}").MessageBody ?? "";
        return json(
          res,
          200,
          { MessageId: randomUUID(), MD5OfMessageBody: createHash("md5").update(msg).digest("hex") },
          { "content-type": "application/x-amz-json-1.0" },
        );
      }
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(
        '<SendEmailResponse xmlns="http://ses.amazonaws.com/doc/2010-12-01/"><SendEmailResult><MessageId>ses-e2e</MessageId></SendEmailResult><ResponseMetadata><RequestId>r1</RequestId></ResponseMetadata></SendEmailResponse>',
      );
    },
    push(req, res, body) {
      const url = req.url ?? "/";
      const auth = String(req.headers.authorization ?? "");
      if (url === "/token") {
        const assertion = new URLSearchParams(body).get("assertion") ?? "";
        if (!verifyJwt(assertion, "RS256", c.googlePublicKey)) return deny(res, assertion.slice(0, 40));
        return json(res, 200, { access_token: c.googleAccessToken, expires_in: 3599, token_type: "Bearer" });
      }
      if (url.startsWith("/v1/projects/")) {
        if (auth !== `Bearer ${c.googleAccessToken}`) return deny(res, auth);
        return json(res, 200, { name: `${url.slice(4).replace(/\/messages:send$/, "")}/messages/1` });
      }
      if (url.startsWith("/3/device/")) {
        const token = /^bearer\s+(\S+)$/i.exec(auth)?.[1] ?? "";
        if (!verifyJwt(token, "ES256", c.apnsPublicKey)) return deny(res, token.slice(0, 40));
        res.writeHead(200, { "apns-id": randomUUID() });
        return res.end();
      }
      json(res, 404, { error: "not found" });
    },
    leak(req, res) {
      // A misbehaving provider echoing the real key: FR-GW-006 must redact it before the app sees it.
      const key = bearer(req);
      if (key !== c.stripe) return deny(res, key);
      json(res, 200, { youSent: key, inBase64: Buffer.from(key).toString("base64") });
    },
  };

  const servers = new Map<Provider, http2.Http2SecureServer>();
  for (const p of PROVIDERS) {
    const server = http2.createSecureServer({ cert: tls.certPem, key: tls.keyPem, allowHTTP1: true }, (req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        counts.set(p, (counts.get(p) ?? 0) + 1);
        handlers[p](req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.set(p, server);
  }
  const port = (p: Provider) => {
    const server = servers.get(p);
    if (!server) throw new Error(`no mock for ${p}`);
    return (server.address() as AddressInfo).port;
  };
  return {
    url: (p: Provider) => `https://localhost:${port(p)}`,
    fakesSeen: () => [...fakes],
    calls: (p: Provider) => counts.get(p) ?? 0,
    close: async () => {
      await Promise.all([...servers.values()].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
export type MockUpstreams = Awaited<ReturnType<typeof startMockUpstreams>>;
