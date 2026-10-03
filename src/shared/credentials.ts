import fs from "node:fs";
import { MSG } from "../constants";
import { CbError } from "./errors";
import { readJsonFile, writeJsonAtomic } from "./files";
import { credentialsPath } from "./paths";
import { type Credentials, CredentialsSchema, type ServerCredentials } from "./schemas";

const normalize = (server: string) => server.replace(/\/+$/, "");

/** M0-D3: device tokens live in ~/.cb/credentials.json (0600). OS keychain later. */
export async function loadCredentials(env: NodeJS.ProcessEnv = process.env): Promise<Credentials> {
  const raw = await readJsonFile(credentialsPath(env));
  return raw ? CredentialsSchema.parse(raw) : { servers: {} };
}

export async function getServerCredentials(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerCredentials | undefined> {
  return (await loadCredentials(env)).servers[normalize(server)];
}

export async function requireServerCredentials(
  server: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerCredentials> {
  const creds = await getServerCredentials(server, env);
  if (!creds) throw new CbError("NOT_LOGGED_IN", MSG.notLoggedIn);
  return creds;
}

export async function saveServerCredentials(
  server: string,
  creds: ServerCredentials,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const all = await loadCredentials(env);
  all.servers[normalize(server)] = creds;
  await writeJsonAtomic(credentialsPath(env), all);
  if (process.platform !== "win32") fs.chmodSync(credentialsPath(env), 0o600);
}

export async function removeServerCredentials(server: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const all = await loadCredentials(env);
  delete all.servers[normalize(server)];
  await writeJsonAtomic(credentialsPath(env), all);
}
