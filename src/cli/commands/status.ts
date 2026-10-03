import type { Command } from "commander";
import { z } from "zod";
import { getServerCredentials } from "../../shared/credentials";
import { formatDuration } from "../../shared/format";
import { createBackendClient } from "../../shared/http";
import { findProjectConfig } from "../../shared/project-config";
import { out, resolveServer } from "../context";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  uptimeSec: z.number(),
  version: z.string(),
  checks: z.record(z.string(), z.enum(["up", "down"])),
});

/** FR-PKG-008 (M0 subset): backend health, login and project link. */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show backend health, login and project link")
    .option("--server <url>", "backend URL")
    .option("--json", "print machine-readable JSON")
    .action(async (opts: { server?: string; json?: boolean }) => {
      const server = resolveServer(opts.server);
      const health = await createBackendClient({ serverUrl: server }).get("/api/health", HealthSchema);
      const creds = await getServerCredentials(server);
      const project = findProjectConfig()?.config;
      if (opts.json) {
        out(
          JSON.stringify({
            server,
            health,
            user: creds?.user ?? null,
            device: creds?.deviceName ?? null,
            project: project ?? null,
          }),
        );
        return;
      }
      const checks = Object.entries(health.checks)
        .map(([name, state]) => `${name} ${state}`)
        .join(", ");
      out(
        `server  ${server}  ${health.status}  (${checks}, uptime ${formatDuration(health.uptimeSec)}, v${health.version})`,
      );
      out(
        `login   ${creds ? `${creds.user.email} (device "${creds.deviceName}")` : 'not logged in — run "npx cb login"'}`,
      );
      out(
        `project ${project ? `${project.projectSlug ?? project.projectId} (default env: ${project.defaultEnvironment})` : 'not linked — run "npx cb init"'}`,
      );
    });
}
