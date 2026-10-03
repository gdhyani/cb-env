import { execFileSync } from "node:child_process";
import path from "node:path";

/** CLI tests run the compiled bin in a child process, exactly as users will. */
export default function setup(): void {
  execFileSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
    stdio: "inherit",
  });
}
