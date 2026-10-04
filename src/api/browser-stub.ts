// FR-API-003: resolved for browser bundles; failing at import keeps server env out of client code.
throw new Error(
  "@cb/env is server-only: import it in server code (API routes, server components), never in the browser.",
);
