import fs from "node:fs";
import { MSG } from "../constants";
import { CbError } from "./errors";
import { readJsonFile, writeJsonAtomic } from "./files";
import { keychainDelete, keychainEnabled, keychainGet, keychainSet } from "./keychain";
import { credentialsPath } from "./paths";
import { type Credentials, CredentialsSchema, type ServerCredentials } from "./schemas";

const normalize = (server: string) => server.replace(/\/+$/, "");

interface StoredSecret {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
}

/** One secret value per server: JSON with the token pair, or a bare legacy device token. */
const encodeSecret = (c: ServerCredentials) =>
  JSON.stringify({ refreshToken: c.token, accessToken: c.accessToken, accessTokenExpiresAt: c.accessTokenExpiresAt });

function decodeSecret(raw: string): StoredSecret {
  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw) as StoredSecret;
    } catch {
      // Fall through: treat as a bare token.
    }
  }
  return { refreshToken: raw };
}

async function readFile(env: NodeJS.ProcessEnv): Promise<Credentials> {
  const raw = await readJsonFile(credentialsPath(env));
  return raw ? CredentialsSchema.parse(raw) : { servers: {} };
}

async function writeFile(all: Credentials, env: NodeJS.ProcessEnv): Promise<void> {
  await writeJsonAtomic(credentialsPath(env), all);
  if (process.platform !== "win32") fs.chmodSync(credentialsPath(env), 0o600);
}

/**
 * PRD §5 / FR-PKG-001: the device token lives in the OS keychain; credentials.json keeps only who and which device.
 * Without a usable keychain the token falls back to credentials.json (0600) with a warning.
 */
export async function getServerCredentials(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerCredentials | undefined> {
  const key = normalize(server);
  const stored = (await readFile(env)).servers[key];
  if (!stored) return undefined;
  const { store, token: fileToken, ...rest } = stored;
  const raw = store === "keychain" ? keychainGet(key, env) : fileToken;
  if (!raw) return undefined;
  const secret = decodeSecret(raw);
  const creds: ServerCredentials = {
    ...rest,
    token: secret.refreshToken,
    accessToken: secret.accessToken,
    accessTokenExpiresAt: secret.accessTokenExpiresAt,
  };
  // Logins from before the keychain store: move the secret off disk on first use (when a keychain exists).
  if (store === "file" && keychainEnabled(env)) await saveServerCredentials(key, creds, env);
  return creds;
}

export async function requireServerCredentials(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerCredentials> {
  const creds = await getServerCredentials(server, env);
  if (!creds) throw new CbError("NOT_LOGGED_IN", MSG.notLoggedIn);
  return creds;
}

/** Returns where the token was stored. */
export async function saveServerCredentials(
  server: string,
  creds: ServerCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"keychain" | "file"> {
  const key = normalize(server);
  const all = await readFile(env);
  const { token: _refresh, accessToken: _access, accessTokenExpiresAt: _exp, ...rest } = creds;
  const secret = encodeSecret(creds);
  if (keychainSet(key, secret, env)) {
    all.servers[key] = { ...rest, store: "keychain" };
  } else {
    all.servers[key] = { ...rest, token: secret, store: "file" };
  }
  await writeFile(all, env);
  return all.servers[key]?.store ?? "file";
}

export async function removeServerCredentials(server: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const key = normalize(server);
  const all = await readFile(env);
  delete all.servers[key];
  keychainDelete(key, env);
  await writeFile(all, env);
}
