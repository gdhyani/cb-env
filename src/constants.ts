export const PRODUCT_NAME = "cb";
export const PACKAGE_NAME = "@cb/env";
export const HOME_DIR_NAME = ".cb";
export const DEFAULT_SERVER = "http://localhost:4200";
export const PORT_RANGE = { min: 7400, max: 7999 } as const;
export const CORRELATION_HEADER = "x-correlation-id";
export const REQUEST_TIMEOUT_MS = 10_000;

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
  badResponse: (server: string, status: number) =>
    `cb: ${server} answered with an unexpected response (HTTP ${status}). Check that --server points at a cb backend.`,
} as const;
