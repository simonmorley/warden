import type { Label } from "@warden/engine";
import type { Fixture } from "@warden/fixtures";
import type { Model } from "./inference/classify";
import type { LabelInput, LabelResult, Scope } from "./ledger";
import type { LedgerPort } from "./pipeline";

/** One page of a demo run, and how long its ground truth waits before being applied. */
export interface DemoStep {
  readonly fixture: Fixture;
  /** Further steps to wait before labelling; 0 labels it straight after its own decision. */
  readonly labelDelay: number;
}

export interface PendingLabel {
  readonly decisionId: string;
  readonly label: Label;
  readonly dueAt: number;
}

export interface RunProgress {
  /** The index of the next step to submit. */
  readonly next: number;
  readonly pending: readonly PendingLabel[];
  readonly done: boolean;
}

export interface DemoLedger extends LedgerPort {
  label(input: LabelInput): Promise<LabelResult>;
}

export const START: RunProgress = { next: 0, pending: [], done: false };

export async function runBatch(
  _ledger: DemoLedger,
  _model: Model,
  _scope: Scope,
  _plan: readonly DemoStep[],
  _progress: RunProgress,
  _batchSize: number,
): Promise<RunProgress> {
  throw new Error("not implemented");
}
