import type { Command } from "commander";
import { z } from "zod";
import { getServerCredentials, removeServerCredentials, requireServerCredentials } from "../../shared/credentials";
import { CbError } from "../../shared/errors";
import { createBackendClient } from "../../shared/http";
import { findProjectConfig } from "../../shared/project-config";
import { getAccessToken } from "../../shared/token";
import { out, resolveServer } from "../context";

const WhoamiSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  memberships: z.array(z.object({ orgId: z.string(), orgName: z.string(), role: z.string() })),
  deviceId: z.string().nullable(),
});

export function registerAccountCommands(program: Command): void {
  program
    .command("whoami")
    .description("Show the logged-in user, organizations and device")
    .option("--server <url>", "backend URL")
    .option("--json", "print JSON")
    .action(async (opts: { server?: string; json?: boolean }) => {
      const server = resolveServer(opts.server);
      const creds = await requireServerCredentials(server);
      const me = await createBackendClient({ serverUrl: server, token: await getAccessToken(server) }).get(
        "/api/cli/whoami",
        WhoamiSchema,
      );
      if (opts.json) {
        out(JSON.stringify({ server, device: creds.deviceName, ...me }));
        return;
      }
      out(`user    ${me.user.name} <${me.user.email}>`);
      out(`server  ${server}`);
      out(`device  ${creds.deviceName}`);
      for (const m of me.memberships) out(`org     ${m.orgName} (${m.role})`);
      const project = findProjectConfig();
      if (project)
        out(`project ${project.config.projectSlug ?? project.config.projectId} (${project.config.defaultEnvironment})`);
    });

  program
    .command("logout")
    .description("Revoke this device and remove its token")
    .option("--server <url>", "backend URL")
    .action(async (opts: { server?: string }) => {
      const server = resolveServer(opts.server);
      const creds = await getServerCredentials(server);
      if (!creds) {
        out(`Not logged in to ${server}.`);
        return;
      }
      try {
        await createBackendClient({ serverUrl: server, token: await getAccessToken(server) }).post(
          "/api/cli/logout",
          {},
          z.unknown(),
        );
      } catch (err) {
        // A token that is already revoked still gets removed locally.
        if (!(err instanceof CbError) || err.code !== "UNAUTHORIZED") throw err;
      }
      await removeServerCredentials(server);
      out(`Logged out of ${server}.`);
    });
}
