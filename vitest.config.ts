import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-build.ts"],
    testTimeout: 20_000,
    // Tests never touch the developer's real OS keychain.
    env: { CB_CREDENTIAL_STORE: "file" },
  },
});
