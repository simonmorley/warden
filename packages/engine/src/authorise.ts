import type { Authorisation, HumanReason, Permission, Policy, Submission } from "./types";

/**
 * Decides whether a validated verdict becomes an automatic block or goes to a human.
 *
 * The verdict only ever proposes. Whether it may act is settled here, from the
 * permission's state and nothing the model said about itself.
 */
export function authorise(permission: Permission, submission: Submission, policy: Policy): Authorisation {
  // Eligibility is fixed before any outcome is known (PRD 6.1).
  const counts = submission.verdict === "phishing" && submission.valid && !submission.duplicate;
  const toHuman = (reason: HumanReason): Authorisation => ({
    route: { to: "human", reason },
    counts,
    permission,
  });

  if (submission.verdict !== "phishing") return toHuman(submission.verdict);
  if (!submission.valid) return toHuman("rejected");
  if (submission.duplicate) return toHuman("duplicate");

  // Checked before state so that a request raced by a revocation says so (PRD 7.2).
  if (submission.epochSeen !== permission.epoch) return toHuman("stale_epoch");
  if (permission.state === "SHADOW") return toHuman("shadow");
  if (permission.state === "EARNING") return toHuman("earning");
  if (permission.unreviewed >= policy.maxUnreviewed) return toHuman("cap_full");

  // The slot is reserved by the same decision that creates the block (PRD 7.3).
  return {
    route: { to: "block" },
    counts,
    permission: { ...permission, unreviewed: permission.unreviewed + 1 },
  };
}
