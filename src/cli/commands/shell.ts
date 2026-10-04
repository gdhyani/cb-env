import path from "node:path";
import type { Command } from "commander";
import { requireProjectConfig } from "../../shared/project-config";
import { resolveEnvironmentName, runCommand } from "./run";

/** The user's interactive shell for this OS. */
export function userShell(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: env.COMSPEC ?? "cmd.exe", args: [] };
  const file = env.SHELL ?? "/bin/sh";
  return { file, args: ["-i"] };
}

/** `(cb:<env>)` in front of the prompt; zsh uses PROMPT, sh/bash PS1 (rc files may override either). */
export function promptEnv(env: NodeJS.ProcessEnv, shell: string, environment: string): NodeJS.ProcessEnv {
  const tag = `(cb:${environment}) `;
  const name = path.basename(shell);
  return name === "zsh"
    ? { ...env, PROMPT: `${tag}${env.PROMPT ?? "%n@%m %1~ %# "}` }
    : { ...env, PS1: `${tag}${env.PS1 ?? "\\u@\\h \\W \\$ "}` };
}

/** FR-PKG-006: a shell with the same env and preload as `cb run`; tools started from it are brokered too. */
export function registerShellCommand(program: Command): void {
  program
    .command("shell")
    .description("Open your shell with cb-managed env and brokered connections")
    .option("--env <name>", "environment (default: project default or `cb env use`)")
    .option("--server <url>", "backend URL")
    .action(async (opts: { env?: string; server?: string }) => {
      const { config } = requireProjectConfig();
      const environment = await resolveEnvironmentName(
        config.projectId,
        opts.env,
        config.defaultEnvironment,
        process.env,
      );
      const { file, args } = userShell();
      const code = await runCommand([file, ...args], {
        env: environment,
        server: opts.server,
        restart: false,
        processEnv: promptEnv(process.env, file, environment),
      });
      process.exit(code);
    });
}
