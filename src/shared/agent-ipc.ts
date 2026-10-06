import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { AGENT_START_TIMEOUT_MS, AGENT_VERSION, ENV } from "../constants";
import { openPrivate } from "./files";
import { agentLogPath, agentSocketPath } from "./paths";

/** CLI → agent requests (newline-delimited JSON over the control socket). */
export const AgentRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    server: z.string().url(),
    projectId: z.string().min(1),
    orgId: z.string().optional(),
    environment: z.string().min(1),
    /** FR-WH-003: where this run's app listens, for webhook delivery (cb run --webhook-port / webhookPort / PORT). */
    webhookPort: z.number().int().min(1).max(65_535).optional(),
    /** The run is still finding its app's port (preload detection): webhooks wait until webhook-port arrives. */
    detectPort: z.boolean().optional(),
  }),
  /** FR-WH-003: the app port this client's run delivers webhooks to, once it is known (PORT may be a cb variable). */
  z.object({
    type: z.literal("webhook-port"),
    server: z.string().url(),
    projectId: z.string().min(1),
    orgId: z.string().optional(),
    environment: z.string().min(1),
    webhookPort: z.number().int().min(1).max(65_535),
  }),
  z.object({ type: z.literal("status") }),
  z.object({ type: z.literal("stop") }),
  /** §13 canary suite only: write the agent's heap snapshot to `file` (refused unless CB_TEST_MODE=1). */
  z.object({ type: z.literal("heap-snapshot"), file: z.string().min(1) }),
]);
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

const SessionSummary = z.object({
  projectId: z.string(),
  projectSlug: z.string().optional(),
  environment: z.string(),
  listeners: z.number(),
  redirects: z.number(),
  clients: z.number(),
  tunnels: z.number(),
  revoked: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Agent → CLI messages: replies plus pushed session events. */
export const AgentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attached"),
    snapshotFile: z.string(),
    session: SessionSummary,
  }),
  z.object({
    type: z.literal("status"),
    pid: z.number(),
    version: z.string(),
    /** Which cb build the agent runs (absent on agents older than this field). */
    build: z.string().optional(),
    uptimeMs: z.number(),
    sessions: z.array(SessionSummary),
  }),
  z.object({ type: z.literal("stopping") }),
  z.object({ type: z.literal("heap-snapshot"), file: z.string() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  /** Snapshot rewritten with different env values: `cb run` restarts the app. */
  z.object({ type: z.literal("config.changed") }),
  z.object({ type: z.literal("access.revoked"), reason: z.string() }),
  z.object({ type: z.literal("access.restored") }),
  /** Free-text notices from the agent (tunnel close reasons), printed by `cb run`. */
  z.object({ type: z.literal("notice"), message: z.string() }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Splits a stream into JSON lines; invalid lines are reported, never thrown into the socket handler. */
export function readLines(socket: net.Socket, onLine: (value: unknown) => void, onInvalid?: (raw: string) => void) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf("\n");
    while (i >= 0) {
      const raw = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (raw) {
        try {
          onLine(JSON.parse(raw));
        } catch {
          onInvalid?.(raw);
        }
      }
      i = buffer.indexOf("\n");
    }
  });
}

export const writeLine = (socket: net.Socket, value: AgentRequest | AgentMessage) => {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
};

export interface AgentConnection {
  socket: net.Socket;
  send(request: AgentRequest): void;
  /** Resolves with the next message of the given type (or an error message). */
  next<T extends AgentMessage["type"]>(type: T): Promise<Extract<AgentMessage, { type: T | "error" }>>;
  onMessage(listener: (message: AgentMessage) => void): void;
  close(): void;
}

/** Connects to a running agent, or resolves undefined when none is listening. */
export function connectAgent(env: NodeJS.ProcessEnv = process.env): Promise<AgentConnection | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(agentSocketPath(env));
    socket.once("error", () => resolve(undefined));
    socket.once("connect", () => {
      const listeners = new Set<(m: AgentMessage) => void>();
      readLines(socket, (value) => {
        const parsed = AgentMessageSchema.safeParse(value);
        if (parsed.success) for (const l of listeners) l(parsed.data);
      });
      resolve({
        socket,
        send: (request) => writeLine(socket, request),
        next: (type) =>
          new Promise((done, fail) => {
            const listener = (m: AgentMessage) => {
              if (m.type === type || m.type === "error") {
                listeners.delete(listener);
                done(m as never);
              }
            };
            listeners.add(listener);
            socket.once("close", () => fail(new Error("cb: the background agent closed the connection")));
          }),
        onMessage: (listener) => listeners.add(listener),
        close: () => socket.end(),
      });
    });
  });
}

/** dist/shared/agent-ipc.js → dist/agent/main.js */
export const agentEntry = () => path.resolve(__dirname, "..", "agent", "main.js");

/** This cb build: version plus the agent file's modification time (a rebuild or reinstall changes it). */
export function agentBuild(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV.agentBuild];
  if (override) return override;
  try {
    return `${AGENT_VERSION}:${Math.round(fs.statSync(agentEntry()).mtimeMs)}`;
  } catch {
    return AGENT_VERSION;
  }
}

/** The running agent's build, or undefined (older agents don't report one, or no answer in 2 s). */
async function runningBuild(conn: AgentConnection): Promise<string | undefined> {
  conn.send({ type: "status" });
  const status = await Promise.race([
    conn.next("status").catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(r, 2_000)),
  ]);
  return status?.type === "status" ? status.build : undefined;
}

/**
 * Replace the running agent only with a newer build: unknown (older agent) → yes; two installs of different ages
 * (two projects) never take turns replacing each other — the newer one wins and stays.
 */
export function shouldReplace(running: string | undefined, mine: string): boolean {
  if (running === undefined) return true;
  if (running === mine) return false;
  const time = (b: string) => Number(b.slice(b.lastIndexOf(":") + 1));
  const [r, m] = [time(running), time(mine)];
  return Number.isFinite(r) && Number.isFinite(m) && r > 0 && m > 0 ? m > r : true;
}

/** Is an agent still listening? (a short-lived connection, closed at once) */
async function probe(env: NodeJS.ProcessEnv): Promise<boolean> {
  const conn = await connectAgent(env);
  conn?.socket.destroy();
  return Boolean(conn);
}

/**
 * FR-AGT-001/007: connect to the agent, starting it detached (own process group, output to the agent log)
 * when it isn't running. A concurrent start by another `cb run` is fine: the loser exits on the single-instance lock.
 */
export async function ensureAgent(env: NodeJS.ProcessEnv = process.env): Promise<AgentConnection> {
  const build = agentBuild(env);
  const existing = await connectAgent(env);
  if (existing) {
    if (!shouldReplace(await runningBuild(existing), build)) return existing;
    // An agent from another cb build (cb was upgraded or rebuilt): replace it so new features are not silently
    // missing. Running apps reconnect on their own (cb run re-attaches when the agent goes away).
    existing.send({ type: "stop" });
    await existing.next("stopping").catch(() => undefined);
    existing.close();
    const gone = Date.now() + AGENT_START_TIMEOUT_MS;
    while (Date.now() < gone && (await probe(env))) await new Promise((r) => setTimeout(r, 100));
  }
  const log = agentLogPath(env);
  const out = openPrivate(log, "a");
  // P5: no other local process may open a debugger in the agent (it holds this device's tokens) with SIGUSR1.
  const noDebugger = process.allowedNodeEnvironmentFlags.has("--disable-sigusr1") ? ["--disable-sigusr1"] : [];
  // An inherited NODE_OPTIONS (--inspect, --require …) would open a debugger or run foreign code in the agent.
  const { NODE_OPTIONS: _ignored, ...agentEnv } = env;
  const child = spawn(process.execPath, [...noDebugger, agentEntry()], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...agentEnv, CB_AGENT_VERSION: AGENT_VERSION, [ENV.agentBuild]: build },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + AGENT_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const conn = await connectAgent(env);
    if (conn) return conn;
  }
  throw new Error(`cb: the background agent did not start. See ${log}`);
}
