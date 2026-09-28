import { describe, expect, it } from "vitest";
import {
  applyLabel,
  DEFAULT_POLICY,
  initialPermission,
  type LabelledDecision,
  type Permission,
} from "../src/index";

const permission = (overrides: Partial<Permission> = {}): Permission =>
  Object.freeze({ ...initialPermission(), ...overrides });

// By default: a counted verdict from epoch 1 that nobody acted on.
const decision = (overrides: Partial<LabelledDecision> = {}): LabelledDecision =>
  Object.freeze({ counted: true, epoch: 1, blocked: false, ...overrides });

describe("applyLabel: the track record", () => {
  it("adds a right label to right and a wrong label to wrong", () => {
    const start = permission({ right: 10, wrong: 1 });

    expect(applyLabel(start, decision(), "right", DEFAULT_POLICY).permission).toMatchObject({ right: 11, wrong: 1 });
    expect(applyLabel(start, decision(), "wrong", DEFAULT_POLICY).permission).toMatchObject({ right: 10, wrong: 2 });
  });

  it("ignores a verdict that didn't count, such as not_phishing or a rejected response", () => {
    const start = permission({ right: 10 });
    const outcome = applyLabel(start, decision({ counted: false }), "wrong", DEFAULT_POLICY);

    expect(outcome).toEqual({ permission: start, reverse: false, events: [] });
  });

  it("ignores a verdict from an earlier epoch: old epochs stay on record but stop counting", () => {
    const start = permission({ epoch: 2, right: 10 });
    const outcome = applyLabel(start, decision({ epoch: 1 }), "right", DEFAULT_POLICY);

    expect(outcome).toEqual({ permission: start, reverse: false, events: [] });
  });
});

describe("applyLabel: earning permission", () => {
  it("keeps SHADOW at 72 clean labels", () => {
    const outcome = applyLabel(permission({ right: 71 }), decision(), "right", DEFAULT_POLICY);

    expect(outcome.permission).toMatchObject({ state: "SHADOW", right: 72 });
    expect(outcome.events).toEqual([]);
  });

  it("enters EARNING on the 73rd, and that label doesn't count towards probation", () => {
    const outcome = applyLabel(permission({ right: 72 }), decision(), "right", DEFAULT_POLICY);

    expect(outcome.permission).toMatchObject({ state: "EARNING", right: 73, probation: 0 });
    expect(outcome.events).toEqual([
      {
        kind: "promoted",
        from: "SHADOW",
        to: "EARNING",
        tally: { epoch: 1, right: 73, wrong: 0, bound: expect.closeTo(0.95, 4) },
      },
    ]);
  });

  it("charges a mistake in SHADOW in credit only: nothing revoked, reset or reversed", () => {
    const outcome = applyLabel(permission({ right: 30 }), decision(), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...initialPermission(), right: 30, wrong: 1 });
    expect(outcome.reverse).toBe(false);
    expect(outcome.events).toEqual([]);
  });

  it("makes one mistake push the target from 73 to 110", () => {
    const at109 = applyLabel(permission({ right: 107, wrong: 1 }), decision(), "right", DEFAULT_POLICY);
    const at110 = applyLabel(permission({ right: 108, wrong: 1 }), decision(), "right", DEFAULT_POLICY);

    expect(at109.permission.state).toBe("SHADOW");
    expect(at110.permission.state).toBe("EARNING");
  });

  it("counts probation checks and promotes to AUTONOMOUS on the 10th", () => {
    const ninth = applyLabel(permission({ state: "EARNING", right: 80, probation: 8 }), decision(), "right", DEFAULT_POLICY);
    const tenth = applyLabel(permission({ state: "EARNING", right: 82, probation: 9 }), decision(), "right", DEFAULT_POLICY);

    expect(ninth.permission).toMatchObject({ state: "EARNING", probation: 9 });
    expect(tenth.permission).toMatchObject({ state: "AUTONOMOUS", right: 83, probation: 0 });
    expect(tenth.events).toEqual([
      {
        kind: "promoted",
        from: "EARNING",
        to: "AUTONOMOUS",
        tally: { epoch: 1, right: 83, wrong: 0, bound: expect.closeTo(0.9558, 4) },
      },
    ]);
  });

  it("restarts probation after a mistake that leaves the bar intact", () => {
    const start = permission({ state: "EARNING", right: 200, probation: 7 });
    const outcome = applyLabel(start, decision(), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toMatchObject({ state: "EARNING", right: 200, wrong: 1, probation: 0 });
    expect(outcome.events).toEqual([
      { kind: "probation_restarted", tally: { epoch: 1, right: 200, wrong: 1, bound: expect.any(Number) } },
    ]);
  });

  it("drops EARNING to SHADOW in the same epoch when a mistake breaks the bar", () => {
    const start = permission({ state: "EARNING", right: 73, probation: 3 });
    const outcome = applyLabel(start, decision(), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...start, state: "SHADOW", wrong: 1, probation: 0 });
    expect(outcome.reverse).toBe(false);
    expect(outcome.events).toEqual([
      { kind: "demoted", from: "EARNING", to: "SHADOW", tally: { epoch: 1, right: 73, wrong: 1, bound: expect.any(Number) } },
    ]);
  });
});

describe("applyLabel: losing permission", () => {
  it("revokes, resets and reverses when an automatic block from this epoch is wrong, as two events", () => {
    const start = permission({ state: "AUTONOMOUS", right: 90, unreviewed: 2 });
    const outcome = applyLabel(start, decision({ blocked: true }), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...initialPermission(), epoch: 2, unreviewed: 1 });
    expect(outcome.reverse).toBe(true);
    expect(outcome.events).toEqual([
      { kind: "revoked", nextEpoch: 2, tally: { epoch: 1, right: 90, wrong: 1, bound: expect.any(Number) } },
      { kind: "reversed", blockEpoch: 1 },
    ]);
  });

  it("revokes even when the scope has already dropped to SHADOW on the bound", () => {
    const start = permission({ state: "SHADOW", right: 80, wrong: 5, unreviewed: 1 });
    const outcome = applyLabel(start, decision({ blocked: true }), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...initialPermission(), epoch: 2 });
    expect(outcome.reverse).toBe(true);
    expect(outcome.events.map((event) => event.kind)).toEqual(["revoked", "reversed"]);
  });

  it("only reverses a wrong block from an older epoch: that permission is already gone", () => {
    const start = permission({ epoch: 2, right: 5, unreviewed: 1 });
    const outcome = applyLabel(start, decision({ epoch: 1, blocked: true }), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...start, unreviewed: 0 });
    expect(outcome.reverse).toBe(true);
    expect(outcome.events).toEqual([{ kind: "reversed", blockEpoch: 1 }]);
  });

  it("counts a correct automatic block and frees its slot", () => {
    const start = permission({ state: "AUTONOMOUS", right: 90, unreviewed: 3 });
    const outcome = applyLabel(start, decision({ blocked: true }), "right", DEFAULT_POLICY);

    expect(outcome).toEqual({ permission: { ...start, right: 91, unreviewed: 2 }, reverse: false, events: [] });
  });

  it("frees the slot of a correct block from an older epoch without counting it", () => {
    const start = permission({ epoch: 2, unreviewed: 1 });
    const outcome = applyLabel(start, decision({ epoch: 1, blocked: true }), "right", DEFAULT_POLICY);

    expect(outcome).toEqual({ permission: { ...start, unreviewed: 0 }, reverse: false, events: [] });
  });

  it("drops AUTONOMOUS to SHADOW when a late mistake nobody acted on breaks the bar, reversing nothing", () => {
    const start = permission({ state: "AUTONOMOUS", right: 83 });
    const outcome = applyLabel(start, decision(), "wrong", DEFAULT_POLICY);

    expect(outcome.permission).toEqual({ ...start, state: "SHADOW", wrong: 1 });
    expect(outcome.reverse).toBe(false);
    expect(outcome.events).toEqual([
      { kind: "demoted", from: "AUTONOMOUS", to: "SHADOW", tally: { epoch: 1, right: 83, wrong: 1, bound: expect.any(Number) } },
    ]);
  });

  it("keeps AUTONOMOUS when a mistake nobody acted on leaves the bar intact", () => {
    const start = permission({ state: "AUTONOMOUS", right: 300 });
    const outcome = applyLabel(start, decision(), "wrong", DEFAULT_POLICY);

    expect(outcome).toEqual({ permission: { ...start, wrong: 1 }, reverse: false, events: [] });
  });

  it("treats labelling a block with no unreviewed slot on record as a bug", () => {
    const start = permission({ state: "AUTONOMOUS", right: 90, unreviewed: 0 });
    expect(() => applyLabel(start, decision({ blocked: true }), "right", DEFAULT_POLICY)).toThrow(RangeError);
  });
});
