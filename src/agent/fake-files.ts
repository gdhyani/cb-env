import fs from "node:fs/promises";
import path from "node:path";
import { cbHome } from "../shared/paths";
import type { Bootstrap } from "../shared/schemas";

/**
 * OQ8: some SDKs read a key *file* (GOOGLE_APPLICATION_CREDENTIALS). The backend sends this device's fake file
 * content; it is written 0600 under CB_HOME/fake/<project>.<env>/ and the key points at it. Fakes only (S1).
 */
/** Where each fake file lives (pure: `cb env print` shows the paths without writing anything). */
export function fakeFilePaths(b: Bootstrap, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const dir = path.join(cbHome(env), "fake", `${b.projectId}.${b.environment}`.replace(/[^A-Za-z0-9._-]/g, "_"));
  // The key becomes a file name: letters, digits and _ only, so it can never leave the folder.
  return Object.fromEntries(
    Object.keys(b.files ?? {}).map((key) => [key, path.join(dir, `${key.replace(/[^A-Za-z0-9_]/g, "_")}.json`)]),
  );
}

export async function writeFakeFiles(
  b: Bootstrap,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  const paths = fakeFilePaths(b, env);
  for (const [key, file] of Object.entries(paths)) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, b.files?.[key] ?? "", { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return paths;
}
