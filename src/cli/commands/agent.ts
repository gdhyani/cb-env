import type { Command } from "commander";
import { connectAgent } from "../../shared/agent-ipc";
import { agentLogPath } from "../../shared/paths";
import { out } from "../context";

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
    .action(async () => {
      const conn = await connectAgent();
      if (!conn) {
        out("cb: the background agent is not running.");
        return;
      }
      conn.send({ type: "stop" });
      await conn.next("stopping").catch(() => undefined);
      conn.close();
      out("cb: background agent stopped.");
    });
}
