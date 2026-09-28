/**
 * Where a fixture's technique came from. There is no captured original: a fixture is written
 * from a technique a survey found, so this records the survey and the technique, and no URL.
 */
export interface Provenance {
  /** The survey this technique came from, e.g. "openphish-2026-09-28". */
  readonly survey: string;
  /** The technique the page exhibits, in the survey's terms. */
  readonly technique: string;
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
  /** Set when a survey prompted this page; null for one written to cover a gap. */
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
