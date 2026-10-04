// FR-API-003 / T3: resolved for browser bundles. Next.js turns `server-only` in a client graph into a build error;
// other bundlers reach the throw, which keeps server env out of client code.
require("server-only");
throw new Error(
  "@cb/env is server-only: import it in server code (API routes, server components), never in the browser.",
);
