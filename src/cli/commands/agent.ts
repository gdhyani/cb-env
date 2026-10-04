import type { Command } from "commander";
import { connectAgent, ensureAgent } from "../../shared/agent-ipc";
import { CbError } from "../../shared/errors";
import { agentLogPath } from "../../shared/paths";
import { findProjectConfig } from "../../shared/project-config";
import { out, resolveServer } from "../context";
import { resolveEnvironmentName } from "./run";

const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

/** FR-AGT-001: inspect or stop the background agent. */
export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Inspect or stop the background agent");

  agent
    .command("status")
    .description("Show whether the agent is running and which environments it serves")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const conn = await connectAgent();
      if (!conn) {
        if (opts.json) out(JSON.stringify({ running: false }));
        else out("cb: the background agent is not running (it starts with `cb run`).");
        return;
      }
      conn.send({ type: "status" });
      const status = await conn.next("status");
      conn.close();
      if (status.type === "error") throw new Error(status.message);
      if (opts.json) {
        out(JSON.stringify({ running: true, ...status }));
        return;
      }
      out(`agent ${status.version} · pid ${status.pid} · up ${minutes(status.uptimeMs)} · log ${agentLogPath()}`);
      if (status.sessions.length === 0) out("no environments attached");
      for (const s of status.sessions)
        out(
          `  ${s.projectSlug ?? s.projectId} / ${s.environment}: ${s.listeners} connection(s), ${s.redirects} redirect(s), ${s.clients} app(s), ${s.tunnels} open tunnel(s)${s.revoked ? " · access revoked" : ""}`,
        );
    });

  agent
    .command("stop")
    .description("Stop the background agent (running apps lose their connections)")
    .action(stopAgent);
}

async function stopAgent(): Promise<void> {
  const conn = await connectAgent();
  if (!conn) {
    out("cb: the background agent is not running.");
    return;
  }
  conn.send({ type: "stop" });
  await conn.next("stopping").catch(() => undefined);
  conn.close();
  out("cb: background agent stopped.");
}

/** FR-PKG-011: start the agent explicitly (warming the linked project's environment) or stop it. */
export function registerUpDownCommands(program: Command): void {
  program
    .command("up")
    .description("Start the background agent and open this project's connections ahead of `cb run`")
    .option("--env <name>", "environment")
    .option("--json", "machine-readable output")
    .action(async (opts: { env?: string; json?: boolean }) => {
      const conn = await ensureAgent();
      const found = findProjectConfig();
      let attached: { environment: string; listeners: number } | undefined;
      if (found) {
        const { config } = found;
        const environment = await resolveEnvironmentName(
          config.projectId,
          opts.env,
          config.defaultEnvironment,
          process.env,
        );
        conn.send({
          type: "attach",
          server: resolveServer(config.server),
          projectId: config.projectId,
          orgId: config.orgId,
          environment,
        });
        const reply = await conn.next("attached");
        if (reply.type === "error") {
          conn.close();
          throw new CbError(reply.code, reply.message);
        }
        attached = { environment, listeners: reply.session.listeners };
      }
      conn.send({ type: "status" });
      const status = await conn.next("status");
      conn.close();
      if (opts.json) {
        out(
          JSON.stringify({
            running: true,
            pid: status.type === "status" ? status.pid : null,
            attached: attached ?? null,
          }),
        );
        return;
      }
      out(`cb: background agent running${status.type === "status" ? ` (pid ${status.pid})` : ""}.`);
      if (attached) out(`cb: ${attached.environment} ready — ${attached.listeners} brokered connection(s).`);
    });

  program
    .command("down")
    .description("Stop the background agent (running apps lose their connections)")
    .action(stopAgent);
}
