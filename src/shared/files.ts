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

/**
 * P10 (S1): opens a file that holds cb's own output (agent log, lock) privately — folder 0700, file 0600 — and tightens
 * one left from an older version. Returns the fd.
 */
export function openPrivate(file: string, flags: "a" | "wx"): number {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, flags, 0o600);
  if (process.platform !== "win32") {
    fs.fchmodSync(fd, 0o600);
    fs.chmodSync(path.dirname(file), 0o700);
  }
  return fd;
}
