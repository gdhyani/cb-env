import type { Command } from "commander";
import { z } from "zod";
import { DEFAULT_SERVER, ENV } from "../../constants";
import { formatDuration } from "../../shared/format";
import { createBackendClient } from "../../shared/http";

const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  uptimeSec: z.number(),
  version: z.string(),
  checks: z.record(z.string(), z.enum(["up", "down"])),
});

interface StatusOptions {
  server: string;
  json?: boolean;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show backend connectivity and health")
    .option("--server <url>", "backend URL", process.env[ENV.server] ?? DEFAULT_SERVER)
    .option("--json", "print machine-readable JSON")
    .action(async (opts: StatusOptions) => {
      const health = await createBackendClient({ serverUrl: opts.server }).get("/api/health", HealthSchema);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ server: opts.server, health })}\n`);
        return;
      }
      const checks = Object.entries(health.checks)
        .map(([name, state]) => `${name} ${state}`)
        .join(", ");
      process.stdout.write(
        `server  ${opts.server}  ${health.status}  (${checks}, uptime ${formatDuration(health.uptimeSec)}, v${health.version})\n`,
      );
    });
}
