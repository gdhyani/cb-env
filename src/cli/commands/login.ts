import os from "node:os";
import type { Command } from "commander";
import { z } from "zod";
import { getServerCredentials, saveServerCredentials } from "../../shared/credentials";
import { CbError } from "../../shared/errors";
import { createBackendClient } from "../../shared/http";
import { note, out, resolveServer } from "../context";
import { openBrowser } from "../open-browser";

const StartSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUrl: z.string(),
  interval: z.number(),
  expiresIn: z.number(),
});
const TokenSchema = z.object({
  token: z.string(),
  device: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
});

/** FR-PKG-001: device-code login approved in the dashboard. */
export async function login(opts: { server?: string; browser?: boolean; pollIntervalMs?: number }): Promise<void> {
  const server = resolveServer(opts.server);
  const client = createBackendClient({ serverUrl: server });
  const start = await client.post(
    "/api/cli/device/start",
    { deviceName: os.hostname(), os: process.platform },
    StartSchema,
  );
  out(`To log in, open ${start.verificationUrl}`);
  out(`and confirm the code: ${start.userCode}`);
  if (opts.browser !== false) openBrowser(start.verificationUrl);
  const deadline = Date.now() + start.expiresIn * 1000;
  const interval = opts.pollIntervalMs ?? start.interval * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const result = await client.post("/api/cli/device/token", { deviceCode: start.deviceCode }, TokenSchema);
      const store = await saveServerCredentials(server, {
        token: result.token,
        deviceId: result.device.id,
        deviceName: result.device.name,
        user: result.user,
      });
      out(`Logged in as ${result.user.email} on ${server} (device "${result.device.name}").`);
      if (store === "file")
        out(
          "cb: no OS keychain available; your device token is stored in ~/.cb/credentials.json (readable only by you).",
        );
      return;
    } catch (err) {
      if (err instanceof CbError && err.code === "DEVICE_AUTH_PENDING") continue;
      throw err;
    }
  }
  throw new CbError(
    "DEVICE_CODE_EXPIRED",
    'cb: the login code expired before it was approved. Run "npx cb login" again.',
  );
}

export function registerLoginCommands(program: Command): void {
  program
    .command("login")
    .description("Log in this device (approve the code in the dashboard)")
    .option("--server <url>", "backend URL")
    .option("--no-browser", "print the URL without opening a browser")
    .action(async (opts: { server?: string; browser: boolean }) => {
      const server = resolveServer(opts.server);
      const existing = await getServerCredentials(server);
      if (existing)
        note(`cb: already logged in as ${existing.user.email}; logging in again replaces this device token.`);
      await login(opts);
    });
}
