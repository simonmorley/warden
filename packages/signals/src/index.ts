export type SignalId =
  | "ip_host"
  | "punycode_host"
  | "many_subdomains"
  | "credential_keywords_in_url"
  | "identifier_in_url"
  | "free_hosting"
  | "password_field"
  | "card_fields"
  | "otp_field"
  | "form_posts_offsite"
  | "form_without_action"
  | "obfuscated_script"
  | "anti_analysis"
  | "script_redirect"
  | "meta_refresh"
  | "bot_api_exfil"
  | "script_sends_offsite"
  | "brand_claim"
  | "brand_host_mismatch"
  | "urgency_language"
  | "login_prompt"
  | "captcha_gate"
  | "hotlinked_assets"
  | "data_uri_images"
  | "hidden_iframe"
  | "noindex";

/** One thing the page does that a verdict may cite as evidence, by its id. */
export interface Signal {
  readonly id: SignalId;
  /** Page-derived, so untrusted: kept short and passed to the model as data. */
  readonly detail: string;
}

export interface Snapshot {
  readonly url: string;
  readonly html: string;
}

export interface Analysis {
  readonly signals: readonly Signal[];
  /** The page's visible text, bounded: where an injected instruction would live. */
  readonly excerpt: string;
}

export { analyse } from "./analyse";
export { FREE_HOSTING, pageIdentity } from "./url";
