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

export const ENV = {
  home: "CB_HOME",
  server: "CB_SERVER_URL",
  token: "CB_TOKEN",
  snapshot: "CB_SNAPSHOT_PATH",
  project: "CB_PROJECT_ID",
  environment: "CB_ENVIRONMENT",
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
