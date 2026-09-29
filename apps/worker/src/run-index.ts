import { DurableObject } from "cloudflare:workers";
import { RunIndexStore } from "./storage/run-index-store";

/**
 * Remembers which scoring runs have been started, so the latest one can be found from any
 * browser. Each run's results live in its own ledger; this holds only their ids, in order.
 */
export class RunIndex extends DurableObject<Env> {
  private readonly store: RunIndexStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RunIndexStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => this.store.migrate());
  }

  /** Records that a run was started. */
  record(runId: string, at: number): void {
    this.store.record(runId, at);
  }

  /** The id of the run started most recently, or null if none has been. */
  latest(): string | null {
    return this.store.latest();
  }
}
