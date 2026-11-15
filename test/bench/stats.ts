/** Linear-interpolated percentile (p in 0..100) of a copy of `samples`, sorted ascending. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile: no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
