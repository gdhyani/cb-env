import fs from "node:fs";

/** One line the preload wrote: a server that started listening in a process run by `cb run`. */
export interface ListenRecord {
  pid: number;
  port: number;
  http: boolean;
  explicit: boolean;
}

/**
 * FR-WH-003: the app's port from what its processes listen on. The newest process that opened an http server on a
 * port it chose (nodemon restarts land here) and, within it, its first such server (a later metrics server is not the
 * app), unless one listens on `preferred` (PORT). Internal servers on random ports (Next.js workers) only count when
 * nothing else is there.
 */
export function pickAppPort(records: ListenRecord[], preferred?: number): number | undefined {
  const web = records.filter((r) => r.http);
  const explicit = web.filter((r) => r.explicit);
  // Several apps under one cb run (e.g. concurrently): the one on PORT is the app the webhooks are for.
  if (preferred !== undefined && explicit.some((r) => r.port === preferred)) return preferred;
  const pool = explicit.length > 0 ? explicit : web;
  const newest = pool.at(-1);
  if (!newest) return undefined;
  return pool.find((r) => r.pid === newest.pid)?.port;
}

function parse(lines: string): ListenRecord[] {
  const out: ListenRecord[] = [];
  for (const line of lines.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<ListenRecord>;
      if (Number.isInteger(r.pid) && Number.isInteger(r.port) && r.port && r.port > 0 && r.port <= 65_535)
        out.push({ pid: r.pid as number, port: r.port, http: r.http === true, explicit: r.explicit === true });
    } catch {
      // a half-written line: read again on the next tick
    }
  }
  return out;
}

/** Polls the listen file (cheap, works on every OS) and calls `onPort` whenever the app's port changes. */
export function watchListenFile(
  file: string,
  onPort: (port: number) => void,
  everyMs = 500,
  preferred?: number,
): { close(): void } {
  let offset = 0;
  let pending = "";
  let current: number | undefined;
  const records: ListenRecord[] = [];
  const tick = () => {
    try {
      const size = fs.statSync(file).size;
      if (size <= offset) return;
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        const text = pending + buf.toString("utf8");
        const cut = text.lastIndexOf("\n");
        pending = text.slice(cut + 1);
        records.push(...parse(text.slice(0, cut + 1)));
        if (records.length > 1_000) records.splice(0, records.length - 1_000);
      } finally {
        fs.closeSync(fd);
      }
      const port = pickAppPort(records, preferred);
      if (port !== undefined && port !== current) {
        current = port;
        onPort(port);
      }
    } catch {
      // not created yet (the app has not listened)
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return {
    close() {
      clearInterval(timer);
      fs.rmSync(file, { force: true });
    },
  };
}
