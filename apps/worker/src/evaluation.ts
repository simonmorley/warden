import { qualify, wilsonLowerBound, wilsonUpperBound, type Policy, type Qualification } from "@warden/engine";
import type { DecisionSummary } from "./ledger-types";

/** What a run measured about its configuration: the model, prompt and policy it was scoped to. */
export interface Evaluation {
  /** Whether this configuration's phishing calls clear the bar, on the whole corpus. */
  readonly qualification: Qualification;
  /** The calls the bar is measured on: valid, non-duplicate "phishing" verdicts that were judged. */
  readonly phishingCalls: {
    readonly right: number;
    readonly wrong: number;
    readonly measured: number | null;
    readonly lower: number | null;
    readonly upper: number | null;
  };
  /** Every verdict, so what the bar deliberately ignores still shows. */
  readonly allCalls: {
    readonly classified: number;
    readonly judged: number;
    readonly right: number;
    readonly missedPhishing: number;
    readonly unusable: number;
  };
}

/**
 * Scores a configuration from a run's decisions, across every epoch: revocation restarts a
 * permission, but the pages judged before it are still evidence about the configuration.
 */
export function evaluate(decisions: readonly DecisionSummary[], policy: Policy): Evaluation {
  const counted = decisions.filter((decision) => decision.counted && decision.label !== null);
  const right = counted.filter((decision) => decision.label === "right").length;
  const n = counted.length;
  const judged = decisions.filter((decision) => decision.label !== null);

  return {
    qualification: qualify(right, n - right, policy),
    phishingCalls: {
      right,
      wrong: n - right,
      measured: n === 0 ? null : right / n,
      lower: wilsonLowerBound(right, n, policy.z),
      upper: wilsonUpperBound(right, n, policy.z),
    },
    allCalls: {
      classified: decisions.length,
      judged: judged.length,
      right: judged.filter((decision) => decision.label === "right").length,
      missedPhishing: judged.filter((decision) => decision.verdict === "not_phishing" && decision.label === "wrong").length,
      unusable: decisions.filter((decision) => !decision.valid || decision.verdict === "uncertain").length,
    },
  };
}
