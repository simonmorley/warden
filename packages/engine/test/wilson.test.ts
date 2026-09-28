import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "../src/index";

// Two-sided 95%, so the lower end is a 97.5% one-sided bound (PRD 6.2).
const Z = 1.96;
const BAR = 0.95;

describe("wilsonLowerBound", () => {
  it("returns null with no evidence, because there is nothing to put a floor under", () => {
    expect(wilsonLowerBound(0, 0, Z)).toBeNull();
  });

  it.each([
    [3, 3, 0.4385],
    [30, 30, 0.8865],
    [73, 73, 0.95],
    [109, 110, 0.9503],
    [140, 142, 0.9501],
  ])("puts %i right out of %i at about %f, as in the PRD's table", (right, n, expected) => {
    expect(wilsonLowerBound(right, n, Z)).toBeCloseTo(expected, 4);
  });

  it("lets a flawless run clear the bar at 73 and not before", () => {
    expect(wilsonLowerBound(72, 72, Z)).toBeLessThan(BAR);
    expect(wilsonLowerBound(73, 73, Z)).toBeGreaterThanOrEqual(BAR);
  });

  it("makes one mistake cost the run until 110", () => {
    expect(wilsonLowerBound(108, 109, Z)).toBeLessThan(BAR);
    expect(wilsonLowerBound(109, 110, Z)).toBeGreaterThanOrEqual(BAR);
  });

  it("makes two mistakes cost the run until 142", () => {
    expect(wilsonLowerBound(139, 141, Z)).toBeLessThan(BAR);
    expect(wilsonLowerBound(140, 142, Z)).toBeGreaterThanOrEqual(BAR);
  });

  it("reduces to n / (n + z²) for a perfect record, as the appendix says", () => {
    for (const n of [1, 3, 30, 73, 500]) {
      expect(wilsonLowerBound(n, n, Z)).toBeCloseTo(n / (n + Z * Z), 12);
    }
  });

  it("climbs with more evidence at the same hit rate", () => {
    for (let n = 1; n < 300; n++) {
      expect(wilsonLowerBound(n + 1, n + 1, Z)!).toBeGreaterThan(wilsonLowerBound(n, n, Z)!);
    }
    const tenth = wilsonLowerBound(9, 10, Z)!;
    const hundredth = wilsonLowerBound(90, 100, Z)!;
    const thousandth = wilsonLowerBound(900, 1000, Z)!;
    expect(tenth).toBeLessThan(hundredth);
    expect(hundredth).toBeLessThan(thousandth);
  });

  it("never leaves [0, 1], including an unbroken run of mistakes", () => {
    expect(wilsonLowerBound(0, 10, Z)).toBe(0);
    for (let n = 1; n <= 50; n++) {
      for (let right = 0; right <= n; right++) {
        const bound = wilsonLowerBound(right, n, Z)!;
        expect(bound).toBeGreaterThanOrEqual(0);
        expect(bound).toBeLessThanOrEqual(1);
      }
    }
  });

  it.each([
    [4, 3],
    [-1, 3],
    [1, -1],
    [1.5, 3],
    [1, Number.NaN],
  ])("refuses impossible counts (%d right out of %d) rather than returning a number", (right, n) => {
    expect(() => wilsonLowerBound(right, n, Z)).toThrow(RangeError);
  });

  it.each([0, -1.96, Number.NaN])("refuses a z of %d", (z) => {
    expect(() => wilsonLowerBound(1, 1, z)).toThrow(RangeError);
  });
});
