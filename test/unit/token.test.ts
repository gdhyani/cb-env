import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getServerCredentials, saveServerCredentials } from "../../src/shared/credentials";
import { getAccessToken } from "../../src/shared/token";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

/** Refresh endpoint stand-in: rotates "cbr_<n>" and counts calls; "cbr_dead" is rejected. */
async function refreshServer() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", async () => {
      calls += 1;
      const { refreshToken } = JSON.parse(body) as { refreshToken: string };
      await new Promise((r) => setTimeout(r, 150)); // widen the race window
      res.setHeader("content-type", "application/json");
      if (refreshToken === "cbr_dead") {
        res.statusCode = 401;
        res.end(
          JSON.stringify({
            success: false,
            error: { code: "INVALID_REFRESH_TOKEN", message: "session ended", statusCode: 401, correlationId: "c" },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          success: true,
          meta: { correlationId: "c" },
          data: {
            accessToken: `access-${calls}`,
            accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
            refreshToken: `cbr_${calls}`,
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
}

const user = { id: "u", name: "U", email: "u@x" };
const home = () => ({ CB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "cbt-")), CB_CREDENTIAL_STORE: "file" });

describe("access-token refresh (FR-AUTH-002/003)", () => {
  it("uses a fresh access token without calling the server", async () => {
    const backend = await refreshServer();
    const env = home();
    await saveServerCredentials(
      backend.url,
      {
        token: "cbr_0",
        accessToken: "still-good",
        accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        deviceId: "d",
        deviceName: "m",
        user,
      },
      env,
    );
    expect(await getAccessToken(backend.url, env)).toBe("still-good");
    expect(backend.calls()).toBe(0);
  });

  it("FR-AGT-006 a token the server rejected (401) is refreshed even if it looks fresh; other callers keep theirs", async () => {
    const backend = await refreshServer();
    const env = home();
    await saveServerCredentials(
      backend.url,
      {
        token: "cbr_0",
        accessToken: "looks-fresh",
        accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        deviceId: "d",
        deviceName: "m",
        user,
      },
      env,
    );
    expect(await getAccessToken(backend.url, env, "some-older-token")).toBe("looks-fresh");
    expect(backend.calls()).toBe(0);
    expect(await getAccessToken(backend.url, env, "looks-fresh")).toBe("access-1");
    expect(backend.calls()).toBe(1);
  });

  it("refreshes an expired token once even with concurrent callers, and stores the rotated pair", async () => {
    const backend = await refreshServer();
    const env = home();
    await saveServerCredentials(backend.url, { token: "cbr_0", deviceId: "d", deviceName: "m", user }, env);
    const results = await Promise.all([getAccessToken(backend.url, env), getAccessToken(backend.url, env)]);
    expect(results).toEqual(["access-1", "access-1"]);
    expect(backend.calls()).toBe(1); // never presents the same refresh token twice
    expect((await getServerCredentials(backend.url, env))?.token).toBe("cbr_1");
  });

  it("an ended session asks the user to log in again", async () => {
    const backend = await refreshServer();
    const env = home();
    await saveServerCredentials(backend.url, { token: "cbr_dead", deviceId: "d", deviceName: "m", user }, env);
    await expect(getAccessToken(backend.url, env)).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
  });

  it("reads a legacy bare device token as the refresh token", async () => {
    const backend = await refreshServer();
    const env = home();
    fs.writeFileSync(
      path.join(env.CB_HOME, "credentials.json"),
      JSON.stringify({
        servers: { [backend.url]: { token: "cbd_legacy", store: "file", deviceId: "d", deviceName: "m", user } },
      }),
    );
    expect((await getServerCredentials(backend.url, env))?.token).toBe("cbd_legacy");
  });
});
