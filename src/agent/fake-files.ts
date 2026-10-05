import fs from "node:fs/promises";
import path from "node:path";
import { cbHome } from "../shared/paths";
import type { Bootstrap } from "../shared/schemas";

/**
 * OQ8: some SDKs read a key *file* (GOOGLE_APPLICATION_CREDENTIALS). The backend sends this device's fake file
 * content; it is written 0600 under CB_HOME/fake/<project>.<env>/ and the key points at it. Fakes only (S1).
 */
export async function writeFakeFiles(
  b: Bootstrap,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const dir = path.join(cbHome(env), "fake", `${b.projectId}.${b.environment}`.replace(/[^A-Za-z0-9._-]/g, "_"));
  const out: Record<string, string> = {};
  const entries = Object.entries(b.files ?? {});
  if (entries.length === 0) return out;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [key, content] of entries) {
    // The key becomes a file name: letters, digits and _ only, so it can never leave the folder.
    const file = path.join(dir, `${key.replace(/[^A-Za-z0-9_]/g, "_")}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, file);
    out[key] = file;
  }
  return out;
}
