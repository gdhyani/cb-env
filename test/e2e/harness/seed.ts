import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "./config";

export interface SeedResource {
  /** Body for POST /api/environments/:envId/resources (kind-specific fields, see cb-backend resource.service). */
  body: Record<string, unknown>;
  /** [ENV_KEY, brokered field] */
  vars: [string, string][];
}
export interface SeedSpec {
  resources: SeedResource[];
  plain?: Record<string, string>;
  generated?: Record<string, string>;
}
export interface Seeded {
  api: string;
  orgId: string;
  projectId: string;
  envId: string;
  cookie: string;
}

/** Cookie-session REST client for the admin (the dashboard's contract, §12.7 envelope). */
async function call(api: string, cookie: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${api}/api${url}`, {
    method,
    headers: { "content-type": "application/json", "x-cb-csrf": "1", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; data?: unknown; error?: { message: string } };
  if (!res.ok || !json.success) throw new Error(`${method} ${url} → ${res.status} ${json.error?.message ?? ""}`);
  return { data: json.data as Record<string, unknown> & { id?: string }, res };
}

/** Admin signs up, creates the project and its resources/variables, and grants themselves the environment. */
export async function seedProject(api: string, spec: SeedSpec): Promise<Seeded> {
  const signup = await fetch(`${api}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "E2E Admin",
      email: `e2e-${randomBytes(4).toString("hex")}@example.test`,
      password: randomBytes(18).toString("base64url"),
      orgName: "E2E Org",
    }),
  });
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
  const cookie = signup.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const me = (await signup.json()) as { data: { user: { id: string }; memberships: { orgId: string }[] } };
  const orgId = me.data.memberships[0]?.orgId ?? "";
  const project = await call(api, cookie, "POST", `/orgs/${orgId}/projects`, { name: "Shop" });
  const envId = (project.data.environments as { id: string }[])[0]?.id ?? "";
  for (const r of spec.resources) {
    const created = await call(api, cookie, "POST", `/environments/${envId}/resources`, r.body);
    for (const [key, field] of r.vars)
      await call(api, cookie, "POST", `/environments/${envId}/variables`, {
        type: "brokered",
        key,
        resourceId: created.data.id,
        field,
      });
  }
  for (const [key, value] of Object.entries(spec.plain ?? {}))
    await call(api, cookie, "POST", `/environments/${envId}/variables`, { type: "plain", key, value });
  for (const [key, format] of Object.entries(spec.generated ?? {}))
    await call(api, cookie, "POST", `/environments/${envId}/variables`, { type: "generated", key, format });
  await call(api, cookie, "POST", `/environments/${envId}/grants`, { userId: me.data.user.id });
  return { api, orgId, projectId: String(project.data.id), envId, cookie };
}

/** Real device-code login: `cb login --no-browser`, the code read from its output and approved by the admin. */
export async function loginCli(cfg: HarnessConfig, seeded: Seeded, cbHome: string): Promise<void> {
  fs.mkdirSync(cbHome, { recursive: true });
  const proc = spawn(
    process.execPath,
    [path.join(cfg.cbEnvDir, "dist/cli/index.js"), "login", "--server", seeded.api, "--no-browser"],
    { env: { ...process.env, CB_HOME: cbHome, CB_CREDENTIAL_STORE: "file" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  proc.stdout.on("data", (d) => {
    out += d;
  });
  proc.stderr.on("data", (d) => {
    out += d;
  });
  const deadline = Date.now() + 20_000;
  let code: string | undefined;
  while (!code && Date.now() < deadline) {
    code = /confirm the code: (\S+)/.exec(out)?.[1];
    if (!code) await new Promise((r) => setTimeout(r, 100));
  }
  if (!code) throw new Error(`cb login printed no code:\n${out}`);
  await call(seeded.api, seeded.cookie, "POST", "/cli/device/approve", { userCode: code });
  const exit = await new Promise<number | null>((r) => proc.once("exit", r));
  if (exit !== 0) throw new Error(`cb login exited ${exit}:\n${out}`);
}

/** Links an example folder to the seeded project (what `cb init` would write). */
export function linkProject(dir: string, seeded: Seeded) {
  fs.mkdirSync(path.join(dir, ".cb"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".cb", "project.json"),
    JSON.stringify(
      { server: seeded.api, orgId: seeded.orgId, projectId: seeded.projectId, defaultEnvironment: "development" },
      null,
      2,
    ),
  );
}
