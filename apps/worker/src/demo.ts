import type { Label } from "@warden/engine";
import type { Fixture } from "@warden/fixtures";
import { analyse } from "@warden/signals";
import { classify, type Classification, type Model } from "./inference/classify";
import type { LabelInput, LabelResult, Scope } from "./ledger";
import { submissionFor, type LedgerPort } from "./pipeline";

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

/**
 * Runs the next batch of a demo plan against a demo ledger, and returns where it got to.
 *
 * Every page is classified by the model at the moment it runs, all of the batch at once;
 * submissions and labels then go in plan order. The epoch is read once, before any
 * inference, so a revocation triggered partway through the batch makes the rest of the
 * batch's decisions stale, exactly as a real revocation races real traffic (PRD 7.2).
 */
export async function runBatch(
  ledger: DemoLedger,
  model: Model,
  scope: Scope,
  plan: readonly DemoStep[],
  progress: RunProgress,
  batchSize: number,
): Promise<RunProgress> {
  if (progress.done) return progress;

  const batch = plan.slice(progress.next, progress.next + batchSize);
  const epochSeen = await ledger.epoch();
  const classifications = await Promise.all(
    batch.map((step) => classify(model, step.fixture.url, analyse(step.fixture))),
  );

  let pending = [...progress.pending];
  for (const [offset, step] of batch.entries()) {
    const index = progress.next + offset;
    const classification = classifications[offset]!;

    const submitted = await ledger.submit(await submissionFor(step.fixture, classification, epochSeen, scope));
    if (!submitted.ok) throw new Error(`the demo ledger refused a submission: ${submitted.error}`);

    const label = groundTruthLabel(step.fixture, classification);
    if (label !== null) pending.push({ decisionId: submitted.decisionId, label, dueAt: index + step.labelDelay });
    pending = await applyDue(ledger, pending, index);
  }

  const next = progress.next + batch.length;
  if (next < plan.length) return { next, pending, done: false };

  // The plan is spent: whatever is still held back gets its label now.
  await applyDue(ledger, pending, Number.POSITIVE_INFINITY);
  return { next, pending: [], done: true };
}

/**
 * What an analyst who knows the page's ground truth would say about the verdict.
 * Uncertain and rejected answers get no label: they never count, so there is nothing to judge.
 */
function groundTruthLabel(fixture: Fixture, classification: Classification): Label | null {
  if (!classification.ok || classification.verdict === "uncertain") return null;
  const saidPhishing = classification.verdict === "phishing";
  return saidPhishing === (fixture.truth === "phishing") ? "right" : "wrong";
}

async function applyDue(ledger: DemoLedger, pending: PendingLabel[], index: number): Promise<PendingLabel[]> {
  const waiting: PendingLabel[] = [];
  for (const item of pending) {
    if (item.dueAt > index) {
      waiting.push(item);
      continue;
    }
    const result = await ledger.label({
      decisionId: item.decisionId,
      label: item.label,
      source: "ground_truth",
      labelledBy: "fixture ground truth",
    });
    if (!result.ok) throw new Error(`the demo ledger refused a label: ${result.error}`);
  }
  return waiting;
}
