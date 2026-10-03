import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Atomic write (tmp + rename), private permissions: 0600 file, 0700 directory. */
export async function writeJsonAtomic(file: string, data: unknown, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await fsp.rename(tmp, file);
}

export function writeJsonAtomicSync(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}
