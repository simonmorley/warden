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
  let next = permission;

  // A label is the review of the block, whichever way it goes, so it frees the slot.
  if (decision.blocked) {
    if (next.unreviewed < 1) {
      throw new RangeError("a blocked decision was labelled, but no unreviewed block is on record");
    }
    next = { ...next, unreviewed: next.unreviewed - 1 };
  }

  // Old epochs stay on record but stop counting.
  const counts = decision.counted && decision.epoch === permission.epoch;
  if (counts) {
    next = label === "right" ? { ...next, right: next.right + 1 } : { ...next, wrong: next.wrong + 1 };
  }

  if (decision.blocked && label === "wrong") {
    const reversed: EngineEvent = { kind: "reversed", blockEpoch: decision.epoch };

    // That epoch's permission is already gone: undo the block and change nothing else.
    if (decision.epoch !== permission.epoch) {
      return { permission: next, reverse: true, events: [reversed] };
    }

    // Anything earned since this block was authorised rests on a record that included
    // a mistake nobody had confirmed yet, so the epoch starts again from zero.
    const revoked: EngineEvent = { kind: "revoked", nextEpoch: permission.epoch + 1, tally: tally(next, policy) };
    return {
      permission: {
        epoch: permission.epoch + 1,
        state: "SHADOW",
        right: 0,
        wrong: 0,
        probation: 0,
        unreviewed: next.unreviewed,
      },
      reverse: true,
      events: [revoked, reversed],
    };
  }

  if (!counts) return { permission: next, reverse: false, events: [] };
  return transition(next, label, policy);
}

/** Re-evaluates the state after a counted label that didn't revoke anything. */
function transition(permission: Permission, label: Label, policy: Policy): LabelOutcome {
  const current = tally(permission, policy);
  const clears = current.bound !== null && current.bound >= policy.requiredScore;
  const outcome = (next: Permission, events: EngineEvent[] = []): LabelOutcome => ({
    permission: next,
    reverse: false,
    events,
  });

  switch (permission.state) {
    case "SHADOW":
      if (!clears) return outcome(permission);
      // The label that crosses the bar opens probation; it isn't the first check of it.
      return outcome({ ...permission, state: "EARNING", probation: 0 }, [
        { kind: "promoted", from: "SHADOW", to: "EARNING", tally: current },
      ]);

    case "EARNING": {
      if (label === "right") {
        const probation = permission.probation + 1;
        if (probation < policy.probationLength) return outcome({ ...permission, probation });
        return outcome({ ...permission, state: "AUTONOMOUS", probation: 0 }, [
          { kind: "promoted", from: "EARNING", to: "AUTONOMOUS", tally: current },
        ]);
      }
      if (!clears) {
        return outcome({ ...permission, state: "SHADOW", probation: 0 }, [
          { kind: "demoted", from: "EARNING", to: "SHADOW", tally: current },
        ]);
      }
      // Probation is a run of checks, so any mistake restarts it, bar or no bar.
      return outcome({ ...permission, probation: 0 }, [{ kind: "probation_restarted", tally: current }]);
    }

    case "AUTONOMOUS":
      if (clears) return outcome(permission);
      // Late labels on verdicts that queued for a human can pull the bound under the bar.
      // Nothing was acted on, so nothing is reversed and the epoch stands.
      return outcome({ ...permission, state: "SHADOW" }, [
        { kind: "demoted", from: "AUTONOMOUS", to: "SHADOW", tally: current },
      ]);

    default: {
      const unreachable: never = permission.state;
      throw new RangeError(`unknown permission state: ${String(unreachable)}`);
    }
  }
}

function tally(permission: Permission, policy: Policy): Tally {
  return {
    epoch: permission.epoch,
    right: permission.right,
    wrong: permission.wrong,
    bound: wilsonLowerBound(permission.right, permission.right + permission.wrong, policy.z),
  };
}
