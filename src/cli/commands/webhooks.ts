import type { Command } from "commander";
import { z } from "zod";
import { newCorrelationId } from "../../shared/correlation";
import { createBackendClient } from "../../shared/http";
import { requireProjectConfig } from "../../shared/project-config";
import { getAccessToken } from "../../shared/token";
import { out, resolveServer } from "../context";
import { resolveEnvironmentName } from "./run";

const ListenResult = z.object({ listening: z.boolean(), expiresAt: z.string().nullable() });

/**
 * FR-WH-002: webhooks normally reach only the device that created the payment object. `cb webhooks listen` also
 * delivers events nobody owns (made in the provider dashboard or with its CLI) to this device for 12 hours.
 */
export function registerWebhooksCommand(program: Command): void {
  const webhooks = program.command("webhooks").description("Webhooks cb delivers to your app");
  webhooks
    .command("listen")
    .description("Also receive webhooks nobody on the team caused (12 h), or stop with --off")
    .option("--off", "stop receiving them")
    .option("--env <name>", "environment (default: project default or `cb env use`)")
    .option("--server <url>", "backend URL")
    .action(async (opts: { off?: boolean; env?: string; server?: string }) => {
      const { config } = requireProjectConfig();
      const server = resolveServer(opts.server, config.server);
      const env = await resolveEnvironmentName(config.projectId, opts.env, config.defaultEnvironment, process.env);
      const client = createBackendClient({
        serverUrl: server,
        token: await getAccessToken(server),
        correlationId: newCorrelationId(),
      });
      const result = await client.post(
        "/api/agent/webhooks/listen",
        { projectId: config.projectId, orgId: config.orgId, env, unmatched: !opts.off },
        ListenResult,
      );
      out(
        result.listening
          ? `cb: this device also receives unclaimed webhooks for ${env} until ${new Date(result.expiresAt ?? "").toLocaleString()} (stop: cb webhooks listen --off)`
          : `cb: this device receives only webhooks for payments it made (${env})`,
      );
    });
}
