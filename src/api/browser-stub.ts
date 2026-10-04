// FR-API-003 / T3: resolved for browser bundles. Next.js sees the `server-only` import in a client graph and fails
// the build; other bundlers load it at runtime, where cb's own message below is the one developers should see.
try {
  require("server-only");
} catch {
  // server-only's generic message is replaced by the specific one below.
}
throw new Error(
  "@cb/env is server-only: import it in server code (API routes, server components), never in the browser.",
);
