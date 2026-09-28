import type { Authorisation, Permission, Policy, Submission } from "./types";

export type * from "./types";
export { wilsonLowerBound } from "./wilson";

export const DEFAULT_POLICY: Policy = { requiredScore: 0.95, z: 1.96, probationLength: 10, maxUnreviewed: 3 };

export function initialPermission(): Permission {
  throw new Error("not implemented");
}

export function authorise(_permission: Permission, _submission: Submission, _policy: Policy): Authorisation {
  throw new Error("not implemented");
}
