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
  try {
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
      fs.chmodSync(path.dirname(file), 0o700);
    }
  } catch (err) {
    fs.closeSync(fd); // M7: never leak the descriptor when tightening fails.
    throw err;
  }
  return fd;
}

export interface LogWriter {
  write(line: string): void;
  close(): void;
}

/**
 * FR-AGT-008 / M7: an append-only log that keeps one private handle open. Before each line it checks the file's size
 * through that handle (other writers, e.g. the agent's own stderr, append to the same file) and, past `maxBytes`,
 * rotates: closes the handle, renames the file to `<file>.1` and opens a fresh one. Only rotation reopens.
 */
export function createLogWriter(file: string, maxBytes: number): LogWriter {
  let fd: number | undefined;
  const open = () => {
    fd ??= openPrivate(file, "a");
    return fd;
  };
  const close = () => {
    if (fd === undefined) return;
    const old = fd;
    fd = undefined;
    fs.closeSync(old);
  };
  return {
    write(line: string) {
      const data = `${line}\n`;
      const size = fs.fstatSync(open()).size;
      if (size > 0 && size + Buffer.byteLength(data) > maxBytes) {
        close();
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // Rotation is best effort (file already gone, or locked on Windows); keep logging to `file`.
        }
      }
      fs.writeSync(open(), data);
    },
    close,
  };
}
