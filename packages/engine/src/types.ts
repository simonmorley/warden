/** SHADOW recommends only; EARNING is probation; AUTONOMOUS may block on its own (PRD 5). */
export type PermissionState = "SHADOW" | "EARNING" | "AUTONOMOUS";

export type Verdict = "phishing" | "not_phishing" | "uncertain";

/** The rules in force. Any change to them is a new policy version, with its own track record. */
export interface Policy {
  /** The bar the Wilson lower bound must reach. */
  readonly requiredScore: number;
  /** 1.96: two-sided 95%, so a 97.5% one-sided bound. */
  readonly z: number;
  /** Consecutive correct checks EARNING needs before AUTONOMOUS. */
  readonly probationLength: number;
  /** Automatic blocks that may await review at once. */
  readonly maxUnreviewed: number;
}

/** One ledger's permission: where it stands and the evidence behind it. */
export interface Permission {
  /** Which attempt at earning permission this is. Counters reset when it changes. */
  readonly epoch: number;
  readonly state: PermissionState;
  /** Counted verdicts labelled right and wrong in this epoch. */
  readonly right: number;
  readonly wrong: number;
  /** Consecutive correct checks during EARNING. */
  readonly probation: number;
  /** Automatic blocks awaiting review, from any epoch. */
  readonly unreviewed: number;
}

/** A verdict the ledger is asked to act on, after the inference adapter has validated it. */
export interface Submission {
  readonly verdict: Verdict;
  /** The response matched the schema and every signal it cited exists. */
  readonly valid: boolean;
  /** This page has already been decided in this ledger. */
  readonly duplicate: boolean;
  /** The epoch the caller saw when it started; a revocation since then makes it stale. */
  readonly epochSeen: number;
}

export type HumanReason =
  | "not_phishing"
  | "uncertain"
  | "rejected"
  | "duplicate"
  | "stale_epoch"
  | "shadow"
  | "earning"
  | "cap_full";

export type Route = { readonly to: "block" } | { readonly to: "human"; readonly reason: HumanReason };

export interface Authorisation {
  readonly route: Route;
  /** Whether a label on this verdict will move the track record. */
  readonly counts: boolean;
  /** The permission after this decision: a block reserves a cap slot. */
  readonly permission: Permission;
}

/** A trusted label says whether the verdict was right. Nothing else moves the track record. */
export type Label = "right" | "wrong";

/** What the engine needs to know about the decision a label is for. */
export interface LabelledDecision {
  /** Whether the verdict was eligible when it was decided (`Authorisation.counts`). */
  readonly counted: boolean;
  /** The epoch the ledger was in when it decided; a block is authorised in the same one. */
  readonly epoch: number;
  /** The verdict became an automatic block, still unreviewed, since labels are applied once. */
  readonly blocked: boolean;
}

/** The numbers an event was decided on, so anyone can recompute it. */
export interface Tally {
  readonly epoch: number;
  readonly right: number;
  readonly wrong: number;
  readonly bound: number | null;
}

export type EngineEvent =
  | {
      readonly kind: "promoted";
      readonly from: "SHADOW" | "EARNING";
      readonly to: "EARNING" | "AUTONOMOUS";
      readonly tally: Tally;
    }
  | {
      readonly kind: "demoted";
      readonly from: "EARNING" | "AUTONOMOUS";
      readonly to: "SHADOW";
      readonly tally: Tally;
    }
  | { readonly kind: "probation_restarted"; readonly tally: Tally }
  | { readonly kind: "revoked"; readonly nextEpoch: number; readonly tally: Tally }
  | { readonly kind: "reversed"; readonly blockEpoch: number };

export interface LabelOutcome {
  readonly permission: Permission;
  /** Undo the decision's block: it was automatic and it was wrong. */
  readonly reverse: boolean;
  readonly events: readonly EngineEvent[];
}
