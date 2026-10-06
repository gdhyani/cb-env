export const PRODUCT_NAME = "cb";
export const PACKAGE_NAME = "@cb/env";
export const HOME_DIR_NAME = ".cb";
export const DEFAULT_SERVER = "http://localhost:4200";
export const PORT_RANGE = { min: 7400, max: 7999 } as const;
export const CORRELATION_HEADER = "x-correlation-id";
export const REQUEST_TIMEOUT_MS = 10_000;
export const AGENT_VERSION = "0.0.0";
export const PROJECT_DIR = ".cb";
export const PROJECT_FILE = "project.json";
export const RESTART_DEBOUNCE_MS = 1_000;
/** FR-AGT-007: the daemon exits after this long with no clients and no tunnels. */
export const AGENT_IDLE_MS = 8 * 60 * 60 * 1000;
/** FR-AGT-007: `cb run` checks the daemon this often and respawns it if missing. */
export const AGENT_HEALTH_MS = 5_000;
export const AGENT_START_TIMEOUT_MS = 8_000;
/** The agent reports version and open tunnels to each backend this often (dashboard "agent online"). */
export const AGENT_HEARTBEAT_MS = 60_000;

export const ENV = {
  home: "CB_HOME",
  server: "CB_SERVER_URL",
  token: "CB_TOKEN",
  snapshot: "CB_SNAPSHOT_PATH",
  /** FR-WH-003: file the preload appends each listening server's port to; cb run picks the app's port from it. */
  listenFile: "CB_LISTEN_FILE",
  project: "CB_PROJECT_ID",
  environment: "CB_ENVIRONMENT",
  /** "file" forces ~/.cb/credentials.json instead of the OS keychain (CI, tests). */
  credentialStore: "CB_CREDENTIAL_STORE",
  /** Overrides AGENT_IDLE_MS (tests). */
  agentIdleMs: "CB_AGENT_IDLE_MS",
  /** Override the event-stream watchdog and backoff cap (soak tests; ms). */
  eventsIdleMs: "CB_EVENTS_IDLE_MS",
  eventsBackoffMaxMs: "CB_EVENTS_BACKOFF_MAX_MS",
  /** "1" enables test-only agent commands (heap snapshot for the §13 canary suite). */
  testMode: "CB_TEST_MODE",
} as const;

// PRD Appendix B — cause, effect, next step.
export const MSG = {
  notLoggedIn: 'cb: you\'re not logged in. Run "npx cb login".',
  notUnderRun:
    'cb: this process wasn\'t started with "cb run". Use "npm run dev" (scripts are wired by "cb init") or "cb shell".',
  unreachable: (server: string) =>
    `cb: can't reach ${server}. Gateway-only mode needs the backend for every connection.`,
  notInitialised: 'cb: this folder isn\'t linked to a cb project. Run "npx cb init".',
  noAccess: (env: string) =>
    `cb: you don't have access to "${env}". Ask an admin to grant it in the dashboard (Access).`,
  revoked: (reason: string) =>
    `cb: access revoked by admin (reason: "${reason}"). Your app was not given any real credentials.`,
  snapshotMissing: (file: string) => `cb: snapshot missing at ${file}. Restart your app with "cb run".`,
  snapshotInvalid: (file: string, field: string) =>
    `cb: snapshot at ${file} is invalid (${field}). Restart your app with "cb run".`,
  badResponse: (server: string, status: number) =>
    `cb: ${server} answered with an unexpected response (HTTP ${status}). Check that --server points at a cb backend.`,
} as const;

/** FR-AGT-006 event stream: the backend heartbeats every 15 s; 45 s of silence = a dead connection. */
export const EVENTS_IDLE_MS = 45_000;
export const EVENTS_TICK_MS = 5_000;
/** A watchdog tick this late means the machine slept (or the process was frozen): reconnect at once. */
export const EVENTS_WAKE_GAP_MS = 20_000;
export const EVENTS_BACKOFF_BASE_MS = 500;
export const EVENTS_BACKOFF_MAX_MS = 30_000;
/** FR-WH-003: how long the app gets to answer a webhook, and how many delivery results the agent remembers. */
export const WEBHOOK_APP_TIMEOUT_MS = 10_000;
export const WEBHOOK_DEDUPE_SIZE = 2_000;
/** App port when neither the run nor the service names one. */
export const WEBHOOK_DEFAULT_PORT = 3000;
