import type { Verdict } from "@warden/engine";
import type { Analysis } from "@warden/signals";

/** The one thing the adapter needs from a model: messages in, a response out. */
export interface Model {
  readonly id: string;
  complete(request: ModelRequest): Promise<unknown>;
}

export interface ModelRequest {
  readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>;
  readonly schema: object;
}

export type Rejection = "schema" | "unresolved_signal" | "no_evidence" | "timeout" | "provider_error";

export type Classification =
  | {
      readonly ok: true;
      readonly verdict: Verdict;
      readonly confidence: number;
      readonly citedSignals: readonly string[];
      readonly reasoning: string;
      readonly raw: string;
    }
  | {
      readonly ok: false;
      readonly rejection: Rejection;
      readonly verdict: Verdict | null;
      readonly raw: string;
    };

export function buildRequest(_url: string, _analysis: Analysis): ModelRequest {
  throw new Error("not implemented");
}

export async function promptVersion(): Promise<string> {
  throw new Error("not implemented");
}

export async function classify(
  _model: Model,
  _url: string,
  _analysis: Analysis,
  _options: { timeoutMs?: number } = {},
): Promise<Classification> {
  throw new Error("not implemented");
}
