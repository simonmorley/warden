import { DEFAULT_POLICY } from "@warden/engine";
import { sha256Hex } from "./hash";
import { promptVersion } from "./inference/classify";
import type { Scope } from "./ledger-types";

/** The policy's version: a hash of the rules in force, so a changed threshold is a new permission. */
export function policyVersion(): Promise<string> {
  return sha256Hex(JSON.stringify(DEFAULT_POLICY));
}

/** The permission a verdict from this model, this prompt and this policy belongs to (PRD 4). */
export async function currentScope(modelId: string): Promise<Scope> {
  const [promptHash, policyHash] = await Promise.all([promptVersion(), policyVersion()]);
  return { abuseType: "phishing", action: "block_url", modelId, promptHash, policyHash };
}

/** Names the scope for ledger lookups: change any part of it and the live ledger starts afresh. */
export function scopeHash(scope: Scope): Promise<string> {
  return sha256Hex(canonicalScope(scope));
}

/** The same scope always serialises to the same string, whatever order its keys arrived in. */
export function canonicalScope(scope: Scope): string {
  const { abuseType, action, modelId, promptHash, policyHash } = scope;
  return JSON.stringify({ abuseType, action, modelId, promptHash, policyHash });
}
