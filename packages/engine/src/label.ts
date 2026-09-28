import { initialPermission } from "./permission";
import type { EngineEvent, Label, LabelledDecision, LabelOutcome, Permission, Policy, Tally } from "./types";
import { wilsonLowerBound } from "./wilson";

/**
 * Applies a trusted label to a decision and returns everything that follows from it
 * (PRD 5-7): the new permission, whether to reverse the decision's block, and the events.
 *
 * What a mistake costs depends on whether the verdict was acted on, not on the state the
 * scope happens to be in when the label lands.
 */
export function applyLabel(
  permission: Permission,
  decision: LabelledDecision,
  label: Label,
  policy: Policy,
): LabelOutcome {
  if (decision.blocked && permission.unreviewed < 1) {
    throw new RangeError("a blocked decision was labelled, but no unreviewed block is on record");
  }

  // A label is the review of the block, whichever way it goes, so it frees the slot.
  const reviewed = decision.blocked ? { ...permission, unreviewed: permission.unreviewed - 1 } : permission;
  // Old epochs stay on record but stop counting.
  const counts = decision.counted && decision.epoch === permission.epoch;
  const next = counts ? counted(reviewed, label) : reviewed;

  if (decision.blocked && label === "wrong") return wrongBlock(permission, next, decision, policy);
  if (!counts) return noEvent(next);
  return transition(next, label, policy);
}

/** Adds the label to the track record. */
function counted(permission: Permission, label: Label): Permission {
  if (label === "right") return { ...permission, right: permission.right + 1 };
  return { ...permission, wrong: permission.wrong + 1 };
}

/**
 * A wrong automatic block is always reversed. If the current epoch authorised it, that
 * epoch is revoked too; if an older one did, its permission is already gone (PRD 7.2).
 */
function wrongBlock(before: Permission, after: Permission, decision: LabelledDecision, policy: Policy): LabelOutcome {
  const reversed: EngineEvent = { kind: "reversed", blockEpoch: decision.epoch };
  if (decision.epoch !== before.epoch) return { permission: after, reverse: true, events: [reversed] };

  // Anything earned since this block was authorised rests on a record that included a
  // mistake nobody had confirmed yet, so the epoch starts again from zero.
  const revoked: EngineEvent = { kind: "revoked", nextEpoch: before.epoch + 1, tally: tally(after, policy) };
  return {
    permission: { ...initialPermission(), epoch: before.epoch + 1, unreviewed: after.unreviewed },
    reverse: true,
    events: [revoked, reversed],
  };
}

/** Re-evaluates the state after a counted label that didn't revoke anything. */
function transition(permission: Permission, label: Label, policy: Policy): LabelOutcome {
  const current = tally(permission, policy);
  const clears = current.bound !== null && current.bound >= policy.requiredScore;

  switch (permission.state) {
    case "SHADOW":
      return fromShadow(permission, current, clears);
    case "EARNING":
      return fromEarning(permission, label, current, clears, policy);
    case "AUTONOMOUS":
      return fromAutonomous(permission, current, clears);
    default: {
      const unreachable: never = permission.state;
      throw new RangeError(`unknown permission state: ${String(unreachable)}`);
    }
  }
}

/** SHADOW enters EARNING when the bound clears the bar. That label opens probation; it isn't its first check. */
function fromShadow(permission: Permission, current: Tally, clears: boolean): LabelOutcome {
  if (!clears) return noEvent(permission);
  return withEvent({ ...permission, state: "EARNING", probation: 0 }, {
    kind: "promoted",
    from: "SHADOW",
    to: "EARNING",
    tally: current,
  });
}

/** EARNING counts correct checks in a row. A mistake restarts probation, or drops to SHADOW if it breaks the bar. */
function fromEarning(permission: Permission, label: Label, current: Tally, clears: boolean, policy: Policy): LabelOutcome {
  if (label === "right") return passCheck(permission, current, policy);
  if (!clears) {
    return withEvent({ ...permission, state: "SHADOW", probation: 0 }, {
      kind: "demoted",
      from: "EARNING",
      to: "SHADOW",
      tally: current,
    });
  }
  // Probation is a run of checks, so any mistake restarts it, bar or no bar.
  return withEvent({ ...permission, probation: 0 }, { kind: "probation_restarted", tally: current });
}

/** One more correct check in probation; the last one promotes to AUTONOMOUS. */
function passCheck(permission: Permission, current: Tally, policy: Policy): LabelOutcome {
  const probation = permission.probation + 1;
  if (probation < policy.probationLength) return noEvent({ ...permission, probation });
  return withEvent({ ...permission, state: "AUTONOMOUS", probation: 0 }, {
    kind: "promoted",
    from: "EARNING",
    to: "AUTONOMOUS",
    tally: current,
  });
}

/**
 * AUTONOMOUS drops to SHADOW, same epoch, when late labels on verdicts that queued for a
 * person pull the bound under the bar. Nothing was acted on, so nothing is reversed.
 */
function fromAutonomous(permission: Permission, current: Tally, clears: boolean): LabelOutcome {
  if (clears) return noEvent(permission);
  return withEvent({ ...permission, state: "SHADOW" }, {
    kind: "demoted",
    from: "AUTONOMOUS",
    to: "SHADOW",
    tally: current,
  });
}

/** The numbers a decision rests on, so anyone can recompute it. */
function tally(permission: Permission, policy: Policy): Tally {
  return {
    epoch: permission.epoch,
    right: permission.right,
    wrong: permission.wrong,
    bound: wilsonLowerBound(permission.right, permission.right + permission.wrong, policy.z),
  };
}

/** An outcome with nothing to announce. */
function noEvent(permission: Permission): LabelOutcome {
  return { permission, reverse: false, events: [] };
}

/** An outcome that announces one change. */
function withEvent(permission: Permission, event: EngineEvent): LabelOutcome {
  return { permission, reverse: false, events: [event] };
}
