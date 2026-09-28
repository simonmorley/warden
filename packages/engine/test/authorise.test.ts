import { describe, expect, it } from "vitest";
import {
  authorise,
  DEFAULT_POLICY,
  initialPermission,
  type Permission,
  type Submission,
} from "../src/index";

const permission = (overrides: Partial<Permission> = {}): Permission =>
  Object.freeze({ ...initialPermission(), ...overrides });

const submission = (overrides: Partial<Submission> = {}): Submission =>
  Object.freeze({ verdict: "phishing", valid: true, duplicate: false, epochSeen: 1, ...overrides });

const autonomous = () => permission({ state: "AUTONOMOUS", right: 83 });

describe("initialPermission", () => {
  it("starts in SHADOW, in epoch 1, with no evidence and nothing unreviewed", () => {
    expect(initialPermission()).toEqual({
      epoch: 1,
      state: "SHADOW",
      right: 0,
      wrong: 0,
      probation: 0,
      unreviewed: 0,
    });
  });
});

describe("authorise: which verdicts count", () => {
  it("counts a valid, first-seen phishing verdict, whatever the state", () => {
    for (const state of ["SHADOW", "EARNING", "AUTONOMOUS"] as const) {
      expect(authorise(permission({ state }), submission(), DEFAULT_POLICY).counts).toBe(true);
    }
  });

  it.each([
    ["not_phishing", { verdict: "not_phishing" }],
    ["uncertain", { verdict: "uncertain" }],
    ["rejected", { valid: false }],
    ["duplicate", { duplicate: true }],
  ] as const)("sends %s to a human without counting it, even in AUTONOMOUS", (reason, overrides) => {
    const result = authorise(autonomous(), submission(overrides), DEFAULT_POLICY);

    expect(result.route).toEqual({ to: "human", reason });
    expect(result.counts).toBe(false);
    expect(result.permission).toEqual(autonomous());
  });
});

describe("authorise: rejected responses", () => {
  it.each(["phishing", "not_phishing", "uncertain"] as const)(
    "reports a rejected response as rejected, whatever verdict it carries (%s)",
    (verdict) => {
      const result = authorise(autonomous(), submission({ verdict, valid: false }), DEFAULT_POLICY);

      expect(result.route).toEqual({ to: "human", reason: "rejected" });
      expect(result.counts).toBe(false);
    },
  );
});

describe("authorise: who may block", () => {
  it.each([
    ["SHADOW", "shadow"],
    ["EARNING", "earning"],
  ] as const)("never blocks in %s, however strong the record", (state, reason) => {
    const strong = permission({ state, right: 500 });
    const result = authorise(strong, submission(), DEFAULT_POLICY);

    expect(result.route).toEqual({ to: "human", reason });
    expect(result.permission).toEqual(strong);
  });

  it("blocks in AUTONOMOUS and reserves a cap slot in the same decision", () => {
    const result = authorise(autonomous(), submission(), DEFAULT_POLICY);

    expect(result.route).toEqual({ to: "block" });
    expect(result.permission).toEqual({ ...autonomous(), unreviewed: 1 });
  });

  it("refuses the fourth unreviewed block and sends it to a human", () => {
    const full = permission({ state: "AUTONOMOUS", right: 83, unreviewed: 3 });
    const result = authorise(full, submission(), DEFAULT_POLICY);

    expect(result.route).toEqual({ to: "human", reason: "cap_full" });
    expect(result.permission).toEqual(full);
  });

  it("uses the last free slot", () => {
    const nearlyFull = permission({ state: "AUTONOMOUS", right: 83, unreviewed: 2 });
    const result = authorise(nearlyFull, submission(), DEFAULT_POLICY);

    expect(result.route).toEqual({ to: "block" });
    expect(result.permission.unreviewed).toBe(3);
  });

  it.each([1, 3])(
    "refuses to block for a caller that saw epoch %i when the ledger is in epoch 2",
    (epochSeen) => {
      const current = permission({ state: "AUTONOMOUS", epoch: 2, right: 83 });
      const result = authorise(current, submission({ epochSeen }), DEFAULT_POLICY);

      expect(result.route).toEqual({ to: "human", reason: "stale_epoch" });
      expect(result.permission).toEqual(current);
    },
  );

  it("still counts a stale-epoch verdict; staleness only stops the block", () => {
    const current = permission({ state: "AUTONOMOUS", epoch: 2 });
    expect(authorise(current, submission({ epochSeen: 1 }), DEFAULT_POLICY).counts).toBe(true);
  });
});
