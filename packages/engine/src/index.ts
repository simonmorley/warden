import type { Label, LabelledDecision, LabelOutcome, Permission, Policy } from "./types";

export type * from "./types";
export { authorise } from "./authorise";
export { DEFAULT_POLICY, initialPermission } from "./permission";
export { wilsonLowerBound } from "./wilson";

export function applyLabel(
  _permission: Permission,
  _decision: LabelledDecision,
  _label: Label,
  _policy: Policy,
): LabelOutcome {
  throw new Error("not implemented");
}
