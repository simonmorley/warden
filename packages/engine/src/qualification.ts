import type { Permission, Policy, Qualification, Standing } from "./types";
import { wilsonLowerBound, wilsonUpperBound } from "./wilson";

/**
 * Where a track record stands against the bar (PRD 6.3): the floor on its true accuracy has
 * cleared it, the ceiling has fallen under it, or the evidence doesn't yet say either way.
 */
export function qualify(right: number, wrong: number, policy: Policy): Qualification {
  const n = right + wrong;
  const lower = wilsonLowerBound(right, n, policy.z);
  if (lower !== null && lower >= policy.requiredScore) return "clears";
  const upper = wilsonUpperBound(right, n, policy.z);
  if (upper !== null && upper < policy.requiredScore) return "unqualifiable";
  return "not_yet";
}

/**
 * The permission's state as it should be reported: SHADOW whose record can't reach the bar
 * is UNQUALIFIABLE. It is derived, never stored, and routes exactly as SHADOW does.
 */
export function standing(permission: Permission, policy: Policy): Standing {
  if (permission.state !== "SHADOW") return permission.state;
  if (qualify(permission.right, permission.wrong, policy) !== "unqualifiable") return "SHADOW";
  return "UNQUALIFIABLE";
}
