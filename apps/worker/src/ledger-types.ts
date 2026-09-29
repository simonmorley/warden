import type { EngineEvent, Label, Permission, Route, Verdict } from "@warden/engine";

// The ledger's public shapes: what callers send it and what it returns over RPC.

/** A demo ledger takes fixture ground truth as its labels; the live ledger only takes a human's. */
export type LedgerKind = "demo" | "live";

/** What a permission belongs to (PRD 4). Change any part and it's a different permission. */
export interface Scope {
  readonly abuseType: "phishing";
  readonly action: "block_url";
  readonly modelId: string;
  readonly promptHash: string;
  readonly policyHash: string;
}

export interface PageRef {
  /** The normalised URL, which deduplication and reversal key on. */
  readonly identity: string;
  /** The exact URL a block would apply to. */
  readonly url: string;
  readonly contentHash: string;
}

/** A classified page, validated by the inference adapter, submitted for a decision. */
export interface SubmitInput {
  readonly page: PageRef;
  readonly verdict: Verdict;
  readonly valid: boolean;
  /** Why validation failed, when it did: schema, unresolved_signal, timeout, provider_error. */
  readonly rejection: string | null;
  readonly citedSignals: readonly string[];
  /** Recorded for the audit trail; it gates nothing. */
  readonly confidence: number | null;
  readonly rawResponse: string;
  readonly epochSeen: number;
  /** The versions in force when the page was classified. */
  readonly scope: Scope;
}

export interface LabelInput {
  readonly decisionId: string;
  readonly label: Label;
  readonly source: "human" | "ground_truth";
  readonly labelledBy: string;
}

export type OpenResult =
  | { readonly ok: true; readonly permission: Permission }
  | { readonly ok: false; readonly error: "kind_mismatch" | "scope_mismatch" };

export type SubmitResult =
  | {
      readonly ok: true;
      readonly decisionId: string;
      readonly route: Route;
      readonly counted: boolean;
      readonly epoch: number;
    }
  | { readonly ok: false; readonly error: "not_open" | "scope_mismatch" };

export type LabelResult =
  | {
      readonly ok: true;
      /** False when the same label was already on record, which makes a repeat a no-op. */
      readonly applied: boolean;
      readonly reversedUrl: string | null;
      readonly events: readonly EngineEvent[];
      readonly permission: Permission;
    }
  | {
      readonly ok: false;
      readonly error: "not_open" | "not_found" | "label_conflict" | "ground_truth_refused";
    };

export interface BlockedUrl {
  readonly url: string;
  readonly decisionId: string;
  readonly epoch: number;
  readonly createdAt: number;
}

export interface RecordedEvent {
  readonly event: EngineEvent;
  readonly decisionId: string;
  readonly createdAt: number;
}

export interface DecisionSummary {
  readonly id: string;
  readonly url: string;
  readonly verdict: Verdict;
  readonly valid: boolean;
  readonly rejection: string | null;
  readonly citedSignals: readonly string[];
  /** As the model stated it: recorded for the audit trail, never used to decide anything. */
  readonly confidence: number | null;
  readonly counted: boolean;
  readonly route: Route;
  /** What became of the decision's block, if it made one. */
  readonly block: "active" | "reversed" | null;
  readonly label: Label | null;
  readonly createdAt: number;
}

export interface RunStatus {
  readonly status: "running" | "done" | "failed";
  readonly next: number;
  readonly total: number;
  readonly reason: string | null;
}

export type StartRunResult =
  | { readonly ok: true; readonly total: number }
  | { readonly ok: false; readonly error: "not_open" | "not_a_demo_ledger" | "already_started" };

/** One label, as the record met it: which decision, which way, and whether it could count. */
export interface Judgement {
  readonly decisionId: string;
  readonly label: Label;
  /** Whether the decision was eligible; a label only moves the record if it was, in the current epoch. */
  readonly counted: boolean;
  /** The epoch the decision was made in. */
  readonly epoch: number;
  readonly labelledAt: number;
}

export interface LedgerState {
  readonly kind: LedgerKind;
  /** Set on a demo ledger once its run has started. */
  readonly run?: RunStatus;
  readonly scope: Scope;
  readonly permission: Permission;
  readonly blocklist: readonly BlockedUrl[];
  readonly decisions: readonly DecisionSummary[];
  readonly events: readonly RecordedEvent[];
  /** Every label, in the order given, so the record can be replayed step by step. */
  readonly judgements: readonly Judgement[];
}
