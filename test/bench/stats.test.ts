import { describe, expect, it } from "vitest";
import { percentile } from "./stats";

describe("bench stats (M7)", () => {
  const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
  it("percentile interpolates linearly on sorted samples", () => {
    expect(percentile(ten, 50)).toBe(5.5);
    expect(percentile(ten, 95)).toBeCloseTo(9.55, 10);
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 100)).toBe(10);
  });
  it("percentile of no samples is an error, not NaN", () => {
    expect(() => percentile([], 50)).toThrow(/no samples/);
  });
});
