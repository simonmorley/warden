import { describe, expect, it } from "vitest";
import {
  applyLabel,
  authorise,
  DEFAULT_POLICY,
  initialPermission,
  type EngineEvent,
  type Label,
  type LabelledDecision,
  type Verdict,
} from "../src/index";

/** Just enough of a ledger to drive the engine end to end: it holds state, nothing more. */
function ledger() {
  let permission = initialPermission();
  const events: EngineEvent[] = [];

  return {
    get permission() {
      return permission;
    },
    events,
    submit(verdict: Verdict = "phishing", epochSeen = permission.epoch) {
      const result = authorise(permission, { verdict, valid: true, duplicate: false, epochSeen }, DEFAULT_POLICY);
      const decision: LabelledDecision = {
        counted: result.counts,
        epoch: permission.epoch,
        blocked: result.route.to === "block",
      };
      permission = result.permission;
      return { route: result.route, decision };
    },
    label(decision: LabelledDecision, label: Label) {
      const outcome = applyLabel(permission, decision, label, DEFAULT_POLICY);
      permission = outcome.permission;
      events.push(...outcome.events);
      return outcome;
    },
    confirm(count: number) {
      for (let i = 0; i < count; i++) this.label(this.submit().decision, "right");
    },
  };
}

describe("the lifecycle in PRD section 13", () => {
  it("earns permission, acts, gets it wrong, and loses it", () => {
    const warden = ledger();

    // 1. Thirty correct calls: a perfect record that the naive rule would promote.
    warden.confirm(30);
    expect(warden.permission).toMatchObject({ state: "SHADOW", right: 30, wrong: 0 });

    // 2. A hard negative the model gets wrong. Credit only: nothing revoked or reversed.
    const hardNegative = warden.submit();
    expect(hardNegative.route).toEqual({ to: "human", reason: "shadow" });
    expect(warden.label(hardNegative.decision, "wrong").reverse).toBe(false);
    expect(warden.permission).toMatchObject({ state: "SHADOW", epoch: 1, right: 30, wrong: 1 });

    // 3. The target has moved from 73 to 110: still SHADOW at 108 of 109, EARNING at 109 of 110.
    warden.confirm(78);
    expect(warden.permission).toMatchObject({ state: "SHADOW", right: 108, wrong: 1 });
    warden.confirm(1);
    expect(warden.permission).toMatchObject({ state: "EARNING", right: 109, wrong: 1, probation: 0 });

    //    Then ten checks of probation.
    warden.confirm(9);
    expect(warden.permission.state).toBe("EARNING");
    warden.confirm(1);
    expect(warden.permission).toMatchObject({ state: "AUTONOMOUS", right: 119, wrong: 1 });

    // 4. A page is blocked with no human involved, and later confirmed.
    const firstBlock = warden.submit();
    expect(firstBlock.route).toEqual({ to: "block" });
    expect(warden.permission.unreviewed).toBe(1);
    warden.label(firstBlock.decision, "right");
    expect(warden.permission).toMatchObject({ state: "AUTONOMOUS", right: 120, unreviewed: 0 });

    // 5. A trap page: a weaponised report on a legitimate page, and the model blocks it.
    //    Meanwhile another caller has started a decision under the current epoch.
    const trap = warden.submit();
    expect(trap.route).toEqual({ to: "block" });
    const inFlightEpoch = warden.permission.epoch;

    // 6-7. Ground truth arrives: it was legitimate. Revoked and reversed, as two events.
    const caught = warden.label(trap.decision, "wrong");
    expect(caught.reverse).toBe(true);
    expect(caught.events).toEqual([
      { kind: "revoked", nextEpoch: 2, tally: { epoch: 1, right: 120, wrong: 2, bound: expect.any(Number) } },
      { kind: "reversed", blockEpoch: 1 },
    ]);
    expect(warden.permission).toEqual({ ...initialPermission(), epoch: 2 });

    // 8. The in-flight decision is refused an automatic block, and so is the next report.
    expect(warden.submit("phishing", inFlightEpoch).route).toEqual({ to: "human", reason: "stale_epoch" });
    expect(warden.submit().route).toEqual({ to: "human", reason: "shadow" });

    // The history of how it got here, in order.
    expect(warden.events.map((event) => event.kind)).toEqual(["promoted", "promoted", "revoked", "reversed"]);
  });
});
