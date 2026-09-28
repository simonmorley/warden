import type { Model } from "./inference/classify";

export interface Dependencies {
  /** The model to classify with, or null when none is configured. */
  model(env: Env): Model | null;
  /** The live ledger's Durable Object name for a scope. */
  liveLedgerName(scopeHash: string): string;
}

export function createApp(_dependencies: Dependencies) {
  return {
    async fetch(_request: Request, _env: Env): Promise<Response> {
      throw new Error("not implemented");
    },
  };
}
