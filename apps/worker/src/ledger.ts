import type { EngineEvent, Label, Permission, Route, Verdict } from "@warden/engine";
import { DurableObject } from "cloudflare:workers";

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
  readonly counted: boolean;
  readonly route: Route;
  readonly label: Label | null;
}

export interface LedgerState {
  readonly kind: LedgerKind;
  readonly scope: Scope;
  readonly permission: Permission;
  readonly blocklist: readonly BlockedUrl[];
  readonly decisions: readonly DecisionSummary[];
  readonly events: readonly RecordedEvent[];
}

export class Ledger extends DurableObject<Env> {
  open(_kind: LedgerKind, _scope: Scope): OpenResult {
    throw new Error("not implemented");
  }

  submit(_input: SubmitInput): SubmitResult {
    throw new Error("not implemented");
  }

  label(_input: LabelInput): LabelResult {
    throw new Error("not implemented");
  }

  state(): LedgerState | null {
    throw new Error("not implemented");
  }
}
