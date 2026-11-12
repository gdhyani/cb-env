import { describe, expect, it } from "vitest";
import { writeSnapshot } from "../helpers/run-node";
import { measureStartup } from "./preload-startup";
import { percentile } from "./stats";

describe("§14 preload startup (M7)", () => {
  it("§14 preload startup adds ≤ 10 ms at the median", async () => {
    const snapshotPath = writeSnapshot({
      env: { PORT: "3000", APP_NAME: "bench" },
      redirects: { "api.cbtest.dev:443": 7499 },
    });
    const without = await measureStartup({ runs: 40, warmup: 5, withPreload: false, snapshotPath });
    const withPreload = await measureStartup({ runs: 40, warmup: 5, withPreload: true, snapshotPath });
    const base = percentile(without, 50);
    const cb = percentile(withPreload, 50);
    console.log(
      `preload startup: node -e 0 median ${base.toFixed(2)} ms, with preload ${cb.toFixed(2)} ms, delta ${(cb - base).toFixed(2)} ms`,
    );
    expect(without).toHaveLength(40);
    expect(cb - base).toBeLessThanOrEqual(10);
  });
});
