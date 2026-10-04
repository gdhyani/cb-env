import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { requireServerCredentials } from "../../shared/credentials";
import { CbError } from "../../shared/errors";
import { createBackendClient } from "../../shared/http";
import { writeProjectConfig } from "../../shared/project-config";
import { out, resolveServer } from "../context";

const OrgSchema = z.object({ id: z.string(), name: z.string(), role: z.string() });
const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  environments: z.array(z.object({ id: z.string(), name: z.string(), hasAccess: z.boolean(), killed: z.boolean() })),
});
const VariableSchema = z.object({ key: z.string(), type: z.string() });

/** Commands that start a Node process (FR-PKG-003). */
const NODE_TOOLS =
  /^(node|nodemon|tsx|ts-node|ts-node-dev|next|nest|vite|remix|nuxt|astro|react-router|tsup|jest|vitest|mocha)\b/;

export function wrapScripts(scripts: Record<string, string>): Record<string, { from: string; to: string }> {
  const changes: Record<string, { from: string; to: string }> = {};
  for (const [name, cmd] of Object.entries(scripts)) {
    if (cmd.startsWith("cb run")) continue;
    if (NODE_TOOLS.test(cmd.trim())) changes[name] = { from: cmd, to: `cb run -- ${cmd}` };
  }
  return changes;
}

function scanDotenvFiles(root: string, keys: Set<string>): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of fs.readdirSync(root).filter((f) => /^\.env(\..+)?$/.test(f) && f !== ".env.example")) {
    const hits = fs
      .readFileSync(path.join(root, file), "utf8")
      .split(/\r?\n/)
      .map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1])
      .filter((k): k is string => Boolean(k && keys.has(k)));
    if (hits.length > 0) found[file] = hits;
  }
  return found;
}

type Prompts = typeof import("@clack/prompts");

async function prompts(): Promise<Prompts> {
  // @clack/prompts is ESM-only; load it lazily from this CommonJS build.
  return import("@clack/prompts");
}

async function choose<T>(
  label: string,
  items: T[],
  toOption: (t: T) => { value: string; label: string; hint?: string },
  match: string | undefined,
  interactive: boolean,
): Promise<T> {
  if (match) {
    const hit = items.find((i) => {
      const o = toOption(i);
      return o.value === match || o.label.toLowerCase() === match.toLowerCase() || o.hint === match;
    });
    if (!hit) throw new CbError("NOT_FOUND", `cb: no ${label} matches "${match}".`);
    return hit;
  }
  const only = items[0];
  if (items.length === 1 && only !== undefined) return only;
  if (items.length === 0)
    throw new CbError("NOT_FOUND", `cb: no ${label}s available. Ask an admin to add you in the dashboard.`);
  if (!interactive) throw new CbError("INPUT_REQUIRED", `cb: several ${label}s found; pass --${label} <id|name>.`);
  const p = await prompts();
  const picked = await p.select({ message: `Choose a ${label}`, options: items.map(toOption) });
  if (p.isCancel(picked)) throw new CbError("CANCELLED", "cb: cancelled.");
  return items.find((i) => toOption(i).value === picked) as T;
}

export async function init(opts: {
  server?: string;
  org?: string;
  project?: string;
  env?: string;
  yes?: boolean;
  cwd?: string;
}): Promise<void> {
  const root = opts.cwd ?? process.cwd();
  const server = resolveServer(opts.server);
  const creds = await requireServerCredentials(server);
  const client = createBackendClient({ serverUrl: server, token: creds.token });
  const interactive = Boolean(process.stdin.isTTY) && !opts.yes;

  const orgs = await client.get("/api/orgs", z.array(OrgSchema));
  const org = await choose("org", orgs, (o) => ({ value: o.id, label: o.name, hint: o.role }), opts.org, interactive);
  const projects = await client.get(`/api/orgs/${org.id}/projects`, z.array(ProjectSchema));
  const project = await choose(
    "project",
    projects,
    (p) => ({ value: p.id, label: p.name, hint: p.slug }),
    opts.project,
    interactive,
  );
  const envs = project.environments;
  const preferred =
    opts.env ?? (interactive ? undefined : (envs.find((e) => e.name === "development")?.name ?? envs[0]?.name));
  const env = await choose(
    "env",
    envs,
    (e) => ({ value: e.name, label: e.name, hint: e.hasAccess ? "access" : "no access" }),
    preferred,
    interactive,
  );

  const file = await writeProjectConfig(root, {
    server,
    orgId: org.id,
    projectId: project.id,
    projectSlug: project.slug,
    defaultEnvironment: env.name,
  });
  out(`Linked ${path.relative(process.cwd(), file) || file} → ${org.name} / ${project.name} / ${env.name}`);
  if (!env.hasAccess)
    out(`Note: you don't have access to "${env.name}" yet. Ask an admin to grant it in the dashboard (Access).`);

  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> };
    const changes = wrapScripts(pkg.scripts ?? {});
    if (Object.keys(changes).length > 0) {
      out("package.json scripts:");
      for (const [name, c] of Object.entries(changes)) {
        out(`  - ${name}: ${c.from}`);
        out(`  + ${name}: ${c.to}`);
      }
      let apply = opts.yes ?? !interactive;
      if (interactive) {
        const p = await prompts();
        const answer = await p.confirm({ message: "Update these scripts?" });
        apply = !p.isCancel(answer) && answer === true;
      }
      if (apply) {
        for (const [name, c] of Object.entries(changes)) (pkg.scripts as Record<string, string>)[name] = c.to;
        fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
        out("Updated package.json.");
      }
    }
  }

  const envRecord = envs.find((e) => e.name === env.name);
  if (envRecord) {
    const variables = await client
      .get(`/api/environments/${envRecord.id}/variables`, z.array(VariableSchema))
      .catch(() => []);
    const leftovers = scanDotenvFiles(root, new Set(variables.map((v) => v.key)));
    for (const [f, keys] of Object.entries(leftovers)) {
      out(
        `Warning: ${f} still defines cb-managed keys: ${keys.join(", ")}. Remove them so no real secrets stay on disk.`,
      );
    }
  }
  out('Next: run your app as usual, e.g. "npm run dev".');
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Link this folder to a cb project and wire package.json scripts")
    .option("--server <url>", "backend URL")
    .option("--org <id|name>", "organization")
    .option("--project <id|slug>", "project")
    .option("--env <name>", "default environment")
    .option("-y, --yes", "accept defaults without prompting")
    .action(init);
}
