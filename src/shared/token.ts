import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MSG } from "../constants";
import { newCorrelationId } from "./correlation";
import { requireServerCredentials, saveServerCredentials } from "./credentials";
import { CbError } from "./errors";
import { openPrivate } from "./files";
import { createBackendClient } from "./http";
import { cbHome } from "./paths";

/** Refresh when less than this is left, so a token never expires mid-request. */
const MIN_REMAINING_MS = 60_000;
const LOCK_WAIT_MS = 15_000;
const STALE_LOCK_MS = 30_000;

const TokenPairSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.string(),
  refreshToken: z.string(),
});

const fresh = (c: { accessToken?: string; accessTokenExpiresAt?: string }) =>
  Boolean(
    c.accessToken && c.accessTokenExpiresAt && Date.parse(c.accessTokenExpiresAt) - Date.now() > MIN_REMAINING_MS,
  );

/**
 * Cross-process lock in CB_HOME: the CLI and the agent must never present the same refresh token twice
 * (the backend treats that as theft and signs the device out, FR-AUTH-003).
 */
async function withLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  const file = path.join(cbHome(env), "token.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(openPrivate(file, "wx"));
      break;
    } catch {
      // A crashed holder leaves the file behind; take over once it is clearly stale.
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS) fs.rmSync(file, { force: true });
      } catch {
        // Removed by its holder in the meantime.
      }
      if (Date.now() > deadline) throw new Error("cb: timed out waiting for another cb process to refresh the login");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/**
 * FR-AUTH-002/003: a valid access token for this server, refreshing (and rotating) when needed. `rejected` is a
 * token the server just refused (401): it is refreshed even if its expiry looks fine (clock skew, rotation).
 */
export async function getAccessToken(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
  rejected?: string,
): Promise<string> {
  const usable = (c: { accessToken?: string; accessTokenExpiresAt?: string }) =>
    fresh(c) && (rejected === undefined || c.accessToken !== rejected);
  const creds = await requireServerCredentials(server, env);
  if (usable(creds)) return creds.accessToken as string;
  return withLock(env, async () => {
    // Another process may have refreshed while we waited for the lock.
    const latest = await requireServerCredentials(server, env);
    if (usable(latest)) return latest.accessToken as string;
    let pair: z.infer<typeof TokenPairSchema>;
    try {
      pair = await createBackendClient({ serverUrl: server, correlationId: newCorrelationId() }).post(
        "/api/cli/token/refresh",
        { refreshToken: latest.token },
        TokenPairSchema,
      );
    } catch (err) {
      if (
        err instanceof CbError &&
        ["INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_REUSED", "VALIDATION_FAILED"].includes(err.code)
      )
        throw new CbError("NOT_LOGGED_IN", `${err.message || MSG.notLoggedIn}`);
      throw err;
    }
    await saveServerCredentials(
      server,
      {
        ...latest,
        token: pair.refreshToken,
        accessToken: pair.accessToken,
        accessTokenExpiresAt: pair.accessTokenExpiresAt,
      },
      env,
    );
    return pair.accessToken;
  });
}
