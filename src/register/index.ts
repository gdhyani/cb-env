import { syncBuiltinESMExports } from "node:module";
import { ENV, MSG } from "../constants";
import { installRedirects } from "./redirect";
import { readSnapshotSync } from "./snapshot";

const INSTALLED = Symbol.for("cb.register.installed");
const g = globalThis as typeof globalThis & { [INSTALLED]?: boolean };

// Preload (`node --require @cb/env/register`): runs before any app code, never touches the network (FR-REG-002).
if (!g[INSTALLED]) {
  g[INSTALLED] = true;
  const file = process.env[ENV.snapshot];
  if (!file) throw new Error(MSG.notUnderRun);
  const snapshot = readSnapshotSync(file);
  if (snapshot.status === "revoked") throw new Error(MSG.revoked(snapshot.revokedReason ?? "access revoked"));
  for (const [key, value] of Object.entries(snapshot.env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  installRedirects(snapshot.redirects, snapshot.orgCaCert);
  syncBuiltinESMExports();
}
