import type { Permission, Policy } from "./types";

export const DEFAULT_POLICY: Policy = {
  requiredScore: 0.95,
  z: 1.96,
  probationLength: 10,
  maxUnreviewed: 3,
};

export function initialPermission(): Permission {
  return { epoch: 1, state: "SHADOW", right: 0, wrong: 0, probation: 0, unreviewed: 0 };
}
