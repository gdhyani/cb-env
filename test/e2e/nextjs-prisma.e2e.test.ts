import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cbEnvFor, cbRunOnce, type RunningApp, runExample } from "./harness/app";
import { servicesAvailable } from "./harness/config";
import { listFiles } from "./harness/scan";
import { type Suite, startSuite } from "./harness/suite";

const dir = path.resolve(__dirname, "../../examples/nextjs-prisma");
const base = "http://127.0.0.1:3300";
const nextMajor = Number(
  JSON.parse(fs.readFileSync(path.join(dir, "node_modules/next/package.json"), "utf8")).version.split(".")[0],
);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/** T3 modes: Turbopack and webpack dev servers, and a production build served by `next start`. */
const MODES = {
  "dev-turbopack": [["next", "dev", ...(nextMajor >= 16 ? [] : ["--turbopack"]), "-p", "3300"]],
  "dev-webpack": [["next", "dev", ...(nextMajor >= 16 ? ["--webpack"] : []), "-p", "3300"]],
  "build-start": [
    ["next", "build"],
    ["next", "start", "-p", "3300"],
  ],
} as const;

/** Finds the server action id Next assigned to placeOrder (manifest location differs between dev and build). */
function actionId(): string | undefined {
  for (const file of listFiles(path.join(dir, ".next")).filter((f) => f.endsWith("server-reference-manifest.json"))) {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as { node?: Record<string, unknown> };
    const id = Object.keys(manifest.node ?? {})[0];
    if (id) return id;
  }
  return undefined;
}

describe.skipIf(!servicesAvailable())(`T3 examples/nextjs-prisma under cb run (Next ${nextMajor})`, () => {
  let suite: Suite;

  beforeAll(async () => {
    suite = await startSuite("nextjs-prisma");
    const { canaries: c, mocks, services } = suite;
    await suite.seed(dir, {
      resources: [
        { body: { kind: "postgres", name: "orders-db", connectionUri: services.pg }, vars: [["DATABASE_URL", "url"]] },
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
          body: {
            kind: "http",
            name: "stripe",
            upstreamUrl: mocks.url("stripe"),
            apiKey: c.stripe,
            redirectHosts: ["api.stripe.com:443"],
          },
          vars: [["STRIPE_SECRET_KEY", "key"]],
        },
        {
          body: {
            kind: "oauth",
            name: "google-sign-in",
            tokenUrl: "https://oauth2.googleapis.com/token",
            clientSecret: c.googleClientSecret,
            upstreamUrl: mocks.url("google-oauth"),
          },
          vars: [["AUTH_GOOGLE_SECRET", "clientSecret"]],
        },
      ],
      generated: { AUTH_SECRET: "base64url:32" },
      plain: { AUTH_GOOGLE_ID: "e2e.apps.googleusercontent.com", SHOP_REGION: "eu", NEXT_PUBLIC_SHOP_NAME: "Acme" },
    });
    spawnSync(npx, ["prisma", "generate"], { cwd: dir, stdio: "ignore" });
    // T4: Prisma's CLI reaches Postgres through the cb listener with the fake URL.
    await cbRunOnce(suite.cfg, {
      dir,
      command: [npx, "prisma", "db", "push"],
      env: cbEnvFor(suite.cbHome, suite.evidence),
      logFile: path.join(suite.evidence, "cli.log"),
    });
  });

  afterAll(async () => {
    await suite?.close();
  });

  for (const [mode, commands] of Object.entries(MODES)) {
    describe(mode, () => {
      let app: RunningApp;
      const save = (name: string, value: unknown) => suite.saveResponse(`${mode}.${name}`, value);

      beforeAll(async () => {
        fs.rmSync(path.join(dir, ".next"), { recursive: true, force: true });
        const env = cbEnvFor(suite.cbHome, suite.evidence);
        const logFile = path.join(suite.evidence, "cli.log");
        for (const cmd of commands.slice(0, -1))
          await cbRunOnce(suite.cfg, { dir, command: [npx, ...cmd], env, logFile });
        app = await runExample(suite.cfg, {
          dir,
          command: [npx, ...(commands.at(-1) ?? [])],
          readyUrl: `${base}/api/auth/providers`,
          env,
          evidenceDir: suite.evidence,
          logFile,
          readyMs: 180_000,
        });
      });

      afterAll(async () => {
        await app?.stop().catch(() => undefined);
      });

      it("T3 route handlers: OpenAI streaming, Stripe, Prisma, Google token exchange", async () => {
        for (const route of ["/api/chat", "/api/pay", "/api/orders", "/api/oauth-check"]) {
          const res = await fetch(`${base}${route}`);
          const text = await res.text();
          save(route.replaceAll("/", "_"), { status: res.status, headers: Object.fromEntries(res.headers), text });
          expect(res.status, `${route}: ${text.slice(0, 300)}`).toBe(200);
          expect(JSON.parse(text)).toMatchObject({ ok: true });
        }
        expect((await (await fetch(`${base}/api/chat`)).json()).result).toBe("hello from e2e");
      });

      it("T3 edge middleware sees plain variables", async () => {
        expect((await fetch(`${base}/api/pay`)).headers.get("x-shop-region")).toBe("eu");
      });

      it("T3 Auth.js boots with the generated AUTH_SECRET and the fake Google secret", async () => {
        const res = await fetch(`${base}/api/auth/providers`);
        expect(await res.json()).toMatchObject({ google: { id: "google" } });
      });

      it("T3 NEXT_PUBLIC_* renders in the page and the server action runs", async () => {
        const html = await (await fetch(`${base}/`)).text();
        save("page", html);
        expect(html).toContain("shop:<!-- -->Acme");
        const id = actionId();
        expect(id, "server action id in the manifest").toBeTruthy();
        const res = await fetch(`${base}/`, {
          method: "POST",
          headers: { "next-action": id ?? "", "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
          body: "[]",
        });
        const payload = await res.text();
        save("action", payload);
        expect(res.status, payload.slice(0, 300)).toBe(200);
        expect(payload).toMatch(/^1:\d+$/m);
      });

      it("T3 every Node process under next is hooked and dumps its env and heap", async () => {
        const pids = await app.dumpEvidence();
        expect(pids.length).toBeGreaterThanOrEqual(3); // cb CLI, agent, next (+ workers)
        await app.agentHeapSnapshot(path.join(suite.evidence, `agent.${mode}.heapsnapshot`));
      });
    });
  }

  it("S1 §13 canary suite incl. Next.js client bundles; mocks never saw a fake", async () => {
    expect(suite.mocks.fakesSeen()).toEqual([]);
    const bundles = listFiles(path.join(dir, ".next", "static"));
    const report = await suite.scan({ "Next.js client bundles": bundles });
    expect(report.leaks).toEqual([]);
  });
});

describe("T3 browser stub (FR-API-003)", () => {
  it("T3 importing @cb/env in a client component fails next build", () => {
    const bad = path.join(dir, "src/app/bad");
    fs.mkdirSync(bad, { recursive: true });
    fs.copyFileSync(path.join(dir, "e2e-fixtures/bad-client.tsx"), path.join(bad, "page.tsx"));
    try {
      const r = spawnSync(npx, ["next", "build"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/server-only/);
    } finally {
      fs.rmSync(bad, { recursive: true, force: true });
      fs.rmSync(path.join(dir, ".next"), { recursive: true, force: true });
    }
  });
});
