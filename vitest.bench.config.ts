import { defineConfig } from "vitest/config";

/** M7 measurements (§6 T2, §14): never part of `npm test`; T2 needs the compose services like `test:e2e`. */
export default defineConfig({
  test: {
    include: ["test/bench/**/*.bench.test.ts"],
    globalSetup: ["test/global-build.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    // Measurements print their numbers; keep test console output visible.
    silent: false,
    env: { CB_CREDENTIAL_STORE: "file" },
  },
});
