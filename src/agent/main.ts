import fs from "node:fs";
import net from "node:net";
import { z } from "zod";
import { AGENT_HEARTBEAT_MS, AGENT_IDLE_MS, AGENT_VERSION, ENV } from "../constants";
import { AgentRequestSchema, readLines, writeLine } from "../shared/agent-ipc";
import { newCorrelationId } from "../shared/correlation";
import { getServerCredentials } from "../shared/credentials";
import { CbError } from "../shared/errors";
import { createBackendClient } from "../shared/http";
import { agentLogPath, agentSocketPath } from "../shared/paths";
import { redact } from "../shared/redact";
import { getAccessToken } from "../shared/token";
import { Session, sessionId } from "./session";

const env = process.env;
const socketPath = agentSocketPath(env);
const logFile = agentLogPath(env);
const idleMs = Number(env[ENV.agentIdleMs] ?? AGENT_IDLE_MS);
const startedAt = Date.now();
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** FR-AGT-008: one line per event, tokens redacted; rotated to agent.log.1 past 5 MB. */
function log(line: string) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${redact(line)}\n`);
  } catch {
    // Logging must never take the agent down.
  }
}

const sessions = new Map<string, Session>();
const clients = new Set<net.Socket>();
let idleSince = Date.now();

async function shutdown(reason: string, code = 0) {
  log(`agent stopping: ${reason}`);
  server.close();
  for (const c of clients) c.destroy();
  await Promise.all([...sessions.values()].map((s) => s.stop()));
  if (process.platform !== "win32") fs.rmSync(socketPath, { force: true });
  process.exit(code);
}

function onClient(socket: net.Socket) {
  clients.add(socket);
  const attached = new Set<Session>();
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    clients.delete(socket);
    for (const s of attached) s.clients.delete(socket);
    if (clients.size === 0) idleSince = Date.now();
  });
  readLines(
    socket,
    async (value) => {
      const parsed = AgentRequestSchema.safeParse(value);
      if (!parsed.success) {
        writeLine(socket, { type: "error", code: "BAD_REQUEST", message: "cb: invalid agent request" });
        return;
      }
      const req = parsed.data;
      if (req.type === "status") {
        writeLine(socket, {
          type: "status",
          pid: process.pid,
          version: AGENT_VERSION,
          uptimeMs: Date.now() - startedAt,
          sessions: [...sessions.values()].map((s) => s.summary()),
        });
        return;
      }
      if (req.type === "stop") {
        writeLine(socket, { type: "stopping" });
        setTimeout(() => void shutdown("stop requested"), 50);
        return;
      }
      const id = sessionId(req);
      let session = sessions.get(id);
      if (!session) {
        session = new Session(req, env, log);
        sessions.set(id, session);
      }
      try {
        await session.start();
      } catch (err) {
        if (!session.agent?.snapshot) sessions.delete(id);
        writeLine(socket, {
          type: "error",
          code: err instanceof CbError ? err.code : "AGENT_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      session.clients.add(socket);
      attached.add(session);
      log(`client attached to ${session.label} (${session.clients.size} client(s))`);
      void heartbeat();
      writeLine(socket, {
        type: "attached",
        snapshotFile: session.agent?.snapshotFile ?? "",
        session: session.summary(),
      });
      if (session.revoked) writeLine(socket, session.revokedMessage());
    },
    () => writeLine(socket, { type: "error", code: "BAD_REQUEST", message: "cb: invalid agent request" }),
  );
}

const server = net.createServer(onClient);

/** FR-AGT-001 single instance: a live agent already owns the socket → exit quietly; a stale socket file → replace it. */
function listen(retried = false) {
  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE" || retried) {
      log(`agent failed to listen: ${err.message}`);
      process.exit(1);
    }
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.end();
      log("another agent is already running; exiting");
      process.exit(0);
    });
    probe.once("error", () => {
      fs.rmSync(socketPath, { force: true });
      listen(true);
    });
  });
  server.listen(socketPath, () => {
    if (process.platform !== "win32") fs.chmodSync(socketPath, 0o600);
    log(`agent ${AGENT_VERSION} listening (pid ${process.pid}, idle exit after ${Math.round(idleMs / 60000)} min)`);
  });
}

/** Heartbeat to every backend we serve: version and open tunnels (dashboard shows the agent online). */
async function heartbeat() {
  const byServer = new Map<string, number>();
  for (const s of sessions.values())
    if (s.agent?.snapshot) byServer.set(s.key.server, (byServer.get(s.key.server) ?? 0) + s.agent.tunnels);
  for (const [server, activeTunnels] of byServer) {
    try {
      if (!(await getServerCredentials(server, env))) continue;
      await createBackendClient({
        serverUrl: server,
        token: await getAccessToken(server, env),
        correlationId: newCorrelationId(),
      }).post("/api/agent/heartbeat", { version: AGENT_VERSION, activeTunnels }, z.unknown());
    } catch (err) {
      log(`heartbeat to ${server} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
setInterval(() => void heartbeat(), AGENT_HEARTBEAT_MS).unref?.();

// FR-AGT-007: exit after the idle period with no clients and no open tunnels.
setInterval(
  () => {
    const tunnels = [...sessions.values()].reduce((n, s) => n + (s.agent?.tunnels ?? 0), 0);
    if (clients.size > 0 || tunnels > 0) {
      idleSince = Date.now();
      return;
    }
    if (Date.now() - idleSince >= idleMs) void shutdown("idle");
  },
  Math.min(60_000, Math.max(250, Math.floor(idleMs / 4))),
).unref?.();

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  log(`agent crashed: ${err.stack ?? err.message}`);
  void shutdown("uncaught exception", 1);
});

listen();
