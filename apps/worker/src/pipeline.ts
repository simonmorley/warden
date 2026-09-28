import { analyse, pageIdentity, type Analysis } from "@warden/signals";
import { sha256Hex } from "./hash";
import { classify, type Classification, type Model } from "./inference/classify";
import type { Scope, SubmitInput, SubmitResult } from "./ledger";

/** What the pipeline needs from a ledger, whether it runs in the Worker or inside the ledger itself. */
export interface LedgerPort {
  epoch(): Promise<number>;
  submit(input: SubmitInput): Promise<SubmitResult>;
}

export interface Page {
  readonly url: string;
  readonly html: string;
}

export interface Outcome {
  readonly analysis: Analysis;
  readonly classification: Classification;
  readonly submission: SubmitResult;
}

/**
 * Snapshot in, decision out: extract signals, classify, submit. The epoch is read before the
 * model is asked, so a revocation that lands while inference is running makes this decision
 * stale, and a stale decision can't block (PRD 7.2).
 */
export async function decide(ledger: LedgerPort, model: Model, scope: Scope, page: Page): Promise<Outcome> {
  pageIdentity(page.url);
  const epochSeen = await ledger.epoch();
  const analysis = analyse(page);
  const classification = await classify(model, page.url, analysis);
  const submission = await ledger.submit(await submissionFor(page, classification, epochSeen, scope));
  return { analysis, classification, submission };
}

/** Turns a classification into what the ledger records. Shared by try-it-live and demo runs. */
export async function submissionFor(
  page: Page,
  classification: Classification,
  epochSeen: number,
  scope: Scope,
): Promise<SubmitInput> {
  return {
    page: { identity: pageIdentity(page.url), url: page.url, contentHash: await sha256Hex(page.html) },
    // A rejected response still needs a verdict on record; the ledger routes it to a human
    // and it never counts, whatever this says.
    verdict: classification.ok ? classification.verdict : (classification.verdict ?? "uncertain"),
    valid: classification.ok,
    rejection: classification.ok ? null : classification.rejection,
    citedSignals: classification.ok ? classification.citedSignals : [],
    confidence: classification.ok ? classification.confidence : null,
    rawResponse: classification.raw,
    epochSeen,
    scope,
  };
}
