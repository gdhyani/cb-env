import { spawn } from "node:child_process";

/** Best effort: open a URL in the default browser without blocking or failing the command. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // The URL is printed too; nothing else to do.
  }
}
