import fs from "node:fs";
import path from "node:path";

export interface HookedProcess {
  pid: number;
  argv: string;
  /** cb's own processes (CLI, agent) vs the developer's app and its tooling. */
  role: "cb" | "app";
}

const CB_ENTRIES = [/dist[\\/]cli[\\/]index\.js/, /dist[\\/]agent[\\/]main\.js/];

/** Every process the evidence hook loaded into, from the `hooked.<pid>` markers (each holds its argv). */
export function hookedProcesses(dir: string): HookedProcess[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^hooked\.\d+$/.test(f))
    .map((f) => {
      const argv = fs.readFileSync(path.join(dir, f), "utf8");
      return {
        pid: Number(f.split(".")[1]),
        argv,
        role: CB_ENTRIES.some((re) => re.test(argv)) ? ("cb" as const) : ("app" as const),
      };
    })
    .sort((a, b) => a.pid - b.pid);
}
