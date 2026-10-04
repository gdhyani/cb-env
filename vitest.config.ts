import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Example apps under cb run against a real backend: `npm run test:e2e` (vitest.e2e.config.ts).
    exclude: ["test/e2e/**", "node_modules/**"],
    globalSetup: ["test/global-build.ts"],
    testTimeout: 20_000,
    // Tests never touch the developer's real OS keychain.
    env: { CB_CREDENTIAL_STORE: "file" },
  },
});
