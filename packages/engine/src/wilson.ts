/**
 * The Wilson score lower bound: given `right` successes out of `n`, the lowest the
 * true rate could plausibly be. It starts low and climbs as evidence accumulates, so a
 * bar on it demands both a high hit rate and enough evidence (PRD 6.2).
 *
 * `z = 1.96` is the two-sided 95% value, which makes this a 97.5% one-sided bound.
 * Returns null when there is no evidence at all, rather than inventing a number.
 */
export function wilsonLowerBound(right: number, n: number, z: number): number | null {
  const interval = wilsonInterval(right, n, z);
  if (!interval) return null;
  return clamp(interval.centre - interval.margin);
}

/**
 * The Wilson score upper bound: the highest the true rate could plausibly be. Once it falls
 * below the bar, no amount of further evidence at this hit rate will clear it (PRD 6.3).
 *
 * The same formula with the sign flipped, at the same `z`. Returns null with no evidence.
 */
export function wilsonUpperBound(right: number, n: number, z: number): number | null {
  const interval = wilsonInterval(right, n, z);
  if (!interval) return null;
  return clamp(interval.centre + interval.margin);
}

/** The interval's centre and half-width, both already divided through; null with no evidence. */
function wilsonInterval(right: number, n: number, z: number): { centre: number; margin: number } | null {
  if (!Number.isInteger(right) || !Number.isInteger(n) || right < 0 || right > n) {
    throw new RangeError(`need whole counts with 0 <= right <= n, got right=${right}, n=${n}`);
  }
  if (!(z > 0) || !Number.isFinite(z)) {
    throw new RangeError(`z must be a positive number, got ${z}`);
  }
  if (n === 0) return null;

  const p = right / n;
  const z2 = z * z;
  const scale = 1 + z2 / n;
  return {
    centre: (p + z2 / (2 * n)) / scale,
    margin: (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / scale,
  };
}

/** Rounding can leave a hair outside [0, 1] at the extremes (p = 0 or p = 1). */
function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
