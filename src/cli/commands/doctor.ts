import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { connectAgent } from "../../shared/agent-ipc";
import { getServerCredentials } from "../../shared/credentials";
import { readJsonFile } from "../../shared/files";
import { createBackendClient } from "../../shared/http";
import { keychainEnabled } from "../../shared/keychain";
import { snapshotPath } from "../../shared/paths";
import { findProjectConfig } from "../../shared/project-config";
import { SnapshotSchema } from "../../shared/schemas";
import { loadState } from "../../shared/state";
import { out, resolveServer } from "../context";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it (cause → effect → next step, FR-PKG-012). */
  fix?: string;
}

/** Provider key shapes that should never sit in a .env file of a cb project. */
export const SECRET_PATTERNS: [string, RegExp][] = [
  ["Stripe live key", /\b(sk|rk)_live_[A-Za-z0-9]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["OpenAI key", /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    "database URL with a password",
    /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis|rediss|amqps?):\/\/[^:\s/]+:[^@\s]+@(?!127\.0\.0\.1|localhost)/,
  ],
];

/** `.env*` files in the project root (not examples). */
export function envFiles(root: string): string[] {
  return fs
    .readdirSync(root)
    .filter((f) => /^\.env(\..+)?$/.test(f) && !/\.(example|sample|template)$/.test(f))
    .map((f) => path.join(root, f));
}

/** FR-PKG-009: secrets that look real, and cb-managed keys still defined locally. */
export function scanEnvFiles(files: string[], managedKeys: Set<string>): Check[] {
  const checks: Check[] = [];
  for (const file of files) {
    const name = path.basename(file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const secrets = new Set<string>();
    const managed: string[] = [];
    for (const line of lines) {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      if (key && managedKeys.has(key)) managed.push(key);
      for (const [label, pattern] of SECRET_PATTERNS) if (pattern.test(line)) secrets.add(label);
    }
    if (secrets.size)
      checks.push({
        name: `${name}: real-looking secrets`,
        status: "fail",
        detail: [...secrets].join(", "),
        fix: `Move these to cb resources in the dashboard and delete them from ${name}; anyone (or any tool) on this machine can read them.`,
      });
    if (managed.length)
      checks.push({
        name: `${name}: cb-managed keys`,
        status: "warn",
        detail: managed.join(", "),
        fix: `cb already provides these; remove them from ${name} so stale values never shadow cb's.`,
      });
    if (!secrets.size && !managed.length) checks.push({ name, status: "ok", detail: "no secrets or cb-managed keys" });
  }
  return checks;
}

const portFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });

/** All checks; never throws (each failure becomes a check). */
export async function runDoctor(serverFlag?: string): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    major >= 22
      ? { name: "Node.js", status: "ok", detail: process.version }
      : { name: "Node.js", status: "fail", detail: process.version, fix: "Install Node.js 22 or newer." },
  );

  const found = findProjectConfig();
  const server = resolveServer(serverFlag);
  try {
    await createBackendClient({ serverUrl: server }).get("/api/health", z.unknown());
    checks.push({ name: "Server", status: "ok", detail: server });
  } catch (err) {
    checks.push({
      name: "Server",
      status: "fail",
      detail: `${server} unreachable (${err instanceof Error ? err.message : err})`,
      fix: "Check your network or CB_SERVER_URL; gateway-only mode needs the backend for every connection.",
    });
  }

  const creds = await getServerCredentials(server).catch(() => undefined);
  checks.push(
    creds
      ? { name: "Login", status: "ok", detail: `${creds.user.email} on "${creds.deviceName}"` }
      : { name: "Login", status: "fail", detail: "not logged in", fix: 'Run "npx cb login".' },
  );
  checks.push(
    keychainEnabled()
      ? { name: "Keychain", status: "ok", detail: "device token stored in the OS keychain" }
      : {
          name: "Keychain",
          status: "warn",
          detail: "no OS keychain; token stored in ~/.cb/credentials.json (0600)",
          fix: "Install/unlock your OS keychain (Linux: Secret Service) for safer token storage.",
        },
  );

  const agent = await connectAgent();
  if (agent) {
    agent.send({ type: "status" });
    const status = await agent.next("status").catch(() => undefined);
    agent.close();
    checks.push({
      name: "Agent",
      status: "ok",
      detail:
        status?.type === "status" ? `running (pid ${status.pid}, ${status.sessions.length} environment(s))` : "running",
    });
  } else checks.push({ name: "Agent", status: "ok", detail: "not running (starts with `cb run` or `cb up`)" });

  // Port conflicts: a persisted listener port taken by something other than our agent.
  const ports = Object.entries((await loadState()).ports);
  const busy: string[] = [];
  if (!agent)
    for (const [key, port] of ports) if (!(await portFree(port))) busy.push(`${port} (${key.split("/").pop()})`);
  checks.push(
    busy.length
      ? {
          name: "Ports",
          status: "fail",
          detail: `in use: ${busy.join(", ")}`,
          fix: "Stop the process using these ports, or delete them from ~/.cb/state.json to reassign.",
        }
      : { name: "Ports", status: "ok", detail: `${ports.length} listener port(s) available` },
  );

  if (!found) {
    checks.push({ name: "Project", status: "warn", detail: "not linked", fix: 'Run "npx cb init" in your project.' });
    return checks;
  }
  const { config, root } = found;
  checks.push({
    name: "Project",
    status: "ok",
    detail: `${config.projectSlug ?? config.projectId} (${config.defaultEnvironment})`,
  });

  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    const scripts =
      (JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    const wired = Object.entries(scripts).filter(([, cmd]) => cmd.includes("cb run"));
    const runnable = Object.entries(scripts).filter(([name]) => ["dev", "start"].includes(name));
    checks.push(
      wired.length
        ? { name: "package.json scripts", status: "ok", detail: `${wired.map(([n]) => n).join(", ")} use cb run` }
        : {
            name: "package.json scripts",
            status: runnable.length ? "warn" : "ok",
            detail: runnable.length ? "no script uses cb run" : "no dev/start scripts",
            fix: runnable.length ? 'Prefix them with "cb run --" (or run "npx cb init" again).' : undefined,
          },
    );
  }

  const snapshot = SnapshotSchema.safeParse(
    await readJsonFile(snapshotPath(config.projectId, config.defaultEnvironment)).catch(() => undefined),
  );
  const managed = new Set(snapshot.success ? Object.keys(snapshot.data.env) : []);
  checks.push(...scanEnvFiles(envFiles(root), managed));
  return checks;
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** FR-PKG-009 / FR-PKG-012: health checks with fixes; exit code 1 when anything fails. */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Check Node, server, login, keychain, agent, ports and .env files for problems")
    .option("--server <url>", "backend URL")
    .option("--json", "print machine-readable JSON")
    .action(async (opts: { server?: string; json?: boolean }) => {
      const checks = await runDoctor(opts.server);
      const failed = checks.some((c) => c.status === "fail");
      if (opts.json) out(JSON.stringify({ ok: !failed, checks }));
      else {
        for (const c of checks) {
          out(`${ICON[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
          if (c.fix && c.status !== "ok") out(`  → ${c.fix}`);
        }
        out(failed ? "\ncb doctor found problems." : "\nAll good.");
      }
      process.exitCode = failed ? 1 : 0;
    });
}
