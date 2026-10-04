import { defineConfig } from "vitest/config";

/** §13/§15 e2e canary suite: example apps under `cb run` against the real backend and test services. */
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/global-build.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    // One backend and shared compose services per file; files run one after another.
    fileParallelism: false,
    env: { CB_CREDENTIAL_STORE: "file" },
  },
});
