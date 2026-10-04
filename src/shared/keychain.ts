import { ENV, PRODUCT_NAME } from "../constants";
import { cbHome } from "./paths";

type EntryCtor = new (
  service: string,
  account: string,
) => {
  getPassword(): string | null | undefined;
  setPassword(value: string): void;
  deletePassword(): boolean | undefined;
};

let entryCtor: EntryCtor | null | undefined;

/** The native keyring module, or null where it can't load (unsupported platform, no Secret Service). */
function loadEntry(): EntryCtor | null {
  if (entryCtor === undefined) {
    try {
      // Lazy: a native module that may be missing on some platforms.
      entryCtor = (require("@napi-rs/keyring") as { Entry: EntryCtor }).Entry;
    } catch {
      entryCtor = null;
    }
  }
  return entryCtor;
}

/** One keychain item per (cb home, server), so separate CB_HOMEs never share a token. */
const entry = (server: string, env: NodeJS.ProcessEnv) => {
  const Entry = loadEntry();
  return Entry ? new Entry(PRODUCT_NAME, `${cbHome(env)}|${server}`) : null;
};

/** PRD §5: macOS Keychain / Windows Credential Manager / Linux Secret Service; `file` forces the 0600 fallback. */
export function keychainEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV.credentialStore] !== "file" && loadEntry() !== null;
}

/** Returns false when the keychain is unavailable (caller falls back to the file store). */
export function keychainSet(server: string, token: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!keychainEnabled(env)) return false;
  try {
    entry(server, env)?.setPassword(token);
    return true;
  } catch {
    return false;
  }
}

export function keychainGet(server: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!keychainEnabled(env)) return undefined;
  try {
    return entry(server, env)?.getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

export function keychainDelete(server: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!keychainEnabled(env)) return;
  try {
    entry(server, env)?.deletePassword();
  } catch {
    // Already gone.
  }
}
