import type { Model } from "./inference/classify";
import { workersAiModel } from "./inference/workers-ai";

/**
 * The model to classify with, from the Worker's bindings, or null when inference isn't
 * configured. The Worker and the ledger both call this, so a demo run and try-it-live
 * always use the same model.
 */
export function modelFor(env: Env): Model | null {
  // Read loosely: the AI binding and its variables are optional until inference is set up.
  const bindings = env as Env & { AI?: Ai; MODEL_ID?: string; AI_GATEWAY_ID?: string };
  if (!bindings.AI || !bindings.MODEL_ID) return null;
  return workersAiModel(bindings.AI, bindings.MODEL_ID, bindings.AI_GATEWAY_ID ?? null);
}
