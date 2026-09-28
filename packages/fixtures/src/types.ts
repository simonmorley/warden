/** Where a seed came from. Never the live URL itself: only hashes and the feed's own reference. */
export interface Provenance {
  readonly feed: string;
  readonly entryId: string;
  readonly firstSeen: string;
  readonly capturedAt: string;
  readonly urlSha256: string;
  readonly pageSha256: string;
}

export type Category =
  | "credential_harvest"
  | "card_capture"
  | "redirect_chain"
  | "obfuscated"
  | "hard_negative"
  | "benign"
  | "ambiguous"
  | "weaponised_report"
  | "evasion";

export interface Fixture {
  readonly id: string;
  /** The reported URL. */
  readonly url: string;
  /** The page snapshot. Data, never served as HTML. */
  readonly html: string;
  /** What the page really is, as set by a person. */
  readonly truth: "phishing" | "legitimate";
  /** Who set the label; null until a person has confirmed it. */
  readonly labelledBy: string | null;
  readonly category: Category;
  /** Siblings from the same kit share a campaign, which makes their correlation visible. */
  readonly campaign: string;
  /** Set for seeds built from a feed candidate; null for pages built by hand. */
  readonly provenance: Provenance | null;
  /** For a generated variant: the seed it came from. */
  readonly seed?: string;
}

export type ViolationKind =
  | "live_url"
  | "working_target"
  | "real_brand"
  | "victim_data"
  | "credential"
  | "unconfirmed_label";

export interface Violation {
  readonly kind: ViolationKind;
  readonly fixture: string;
  readonly detail: string;
}
