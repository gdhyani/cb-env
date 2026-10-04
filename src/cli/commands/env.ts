import type { Command } from "commander";
import { fetchBootstrap } from "../../agent/agent";
import { renderSnapshot } from "../../agent/snapshot";
import { newCorrelationId } from "../../shared/correlation";
import { requireServerCredentials } from "../../shared/credentials";
import { requireProjectConfig } from "../../shared/project-config";
import { loadState, saveState } from "../../shared/state";
import { getAccessToken } from "../../shared/token";
import { out, resolveServer } from "../context";
import { resolveEnvironmentName } from "./run";

export function registerEnvCommands(program: Command): void {
  const env = program.command("env").description("Inspect or switch the environment");

  env
    .command("print")
    .description("Print the env your app will see (fake and personal values only)")
    .option("--env <name>", "environment")
    .option("--json", "print JSON")
    .action(async (opts: { env?: string; json?: boolean }) => {
      const { config } = requireProjectConfig();
      const server = resolveServer(config.server);
      await requireServerCredentials(server);
      const environment = await resolveEnvironmentName(
        config.projectId,
        opts.env,
        config.defaultEnvironment,
        process.env,
      );
      const b = await fetchBootstrap({
        serverUrl: server,
        getToken: () => getAccessToken(server),
        projectId: config.projectId,
        orgId: config.orgId,
        environment,
        correlationId: newCorrelationId(),
      });
      const ports = (await loadState()).ports;
      const scope = `${b.projectId}/${b.environment}/`;
      const snapshot = renderSnapshot(b, (key) => ports[scope + key] ?? 0);
      const display = Object.fromEntries(
        Object.entries(snapshot.env).map(([k, v]) => [k, v.replaceAll("127.0.0.1:0", "127.0.0.1:<port>")]),
      );
      if (opts.json) {
        out(JSON.stringify({ environment, env: display, visibleKeys: snapshot.visibleKeys, redirects: b.redirects }));
        return;
      }
      for (const [k, v] of Object.entries(display).sort(([a], [z]) => a.localeCompare(z))) {
        out(`${k}=${v}${snapshot.visibleKeys.includes(k) ? "   # visible: real value" : ""}`);
      }
      for (const r of b.redirects) out(`# ${r.host}:${r.port} → agent (TLS terminated by the gateway)`);
    });

  env
    .command("use <name>")
    .description("Set your default environment for this project")
    .action(async (name: string) => {
      const { config } = requireProjectConfig();
      const state = await loadState();
      state.environments[config.projectId] = name;
      await saveState(state);
      out(`Default environment for ${config.projectSlug ?? config.projectId} is now "${name}".`);
    });
}
