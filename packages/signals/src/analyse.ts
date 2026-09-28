import { decodeBase64 } from "./base64";
import type { Analysis, Signal, SignalId, Snapshot } from "./index";
import { parsePage, type ParsedPage } from "./page";
import { freeHostingPlatform, hostOf, isIpLiteral, parseUrl, siteOf } from "./url";

const DETAIL_LIMIT = 160;
const EXCERPT_LIMIT = 1500;

/**
 * Turns a page snapshot into the signals a verdict may cite, and a bounded excerpt of its
 * text. Pure and deterministic: evidence references resolve against exactly this output.
 */
export function analyse(snapshot: Snapshot): Analysis {
  const url = parseUrl(snapshot.url);
  const pageHost = url?.host ?? "";
  const page = parsePage(snapshot.html);
  const signals = new Map<SignalId, string>();
  const raise = (id: SignalId, detail: string) => {
    if (!signals.has(id)) signals.set(id, bounded(detail));
  };

  if (url) urlSignals(url.host, `${url.host}${url.path}`, `${url.query}${url.fragment}`, raise);
  formSignals(page, pageHost, raise);
  scriptSignals(page, pageHost, raise);
  contentSignals(page, pageHost, raise);

  return {
    signals: [...signals].map(([id, detail]): Signal => ({ id, detail })),
    excerpt: excerptOf(page),
  };
}

type Raise = (id: SignalId, detail: string) => void;

const CREDENTIAL_WORDS = [
  "login", "log-in", "signin", "sign-in", "verify", "verification", "account", "secure", "update",
  "confirm", "wallet", "recover", "unlock", "password", "validate", "banking", "webmail", "suspend",
];
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;

function urlSignals(host: string, hostAndPath: string, queryAndFragment: string, raise: Raise) {
  if (isIpLiteral(host)) raise("ip_host", host);
  if (host.split(".").some((label) => label.startsWith("xn--"))) raise("punycode_host", host);
  if (host.split(".").length >= 5) raise("many_subdomains", host);

  const platform = freeHostingPlatform(host);
  if (platform !== null) raise("free_hosting", platform);

  const lowered = hostAndPath.toLowerCase();
  const words = CREDENTIAL_WORDS.filter((word) => lowered.includes(word));
  if (words.length > 0) raise("credential_keywords_in_url", words.join(", "));

  // Kits personalise the lure: the target's address rides along in the query or fragment,
  // often base64-encoded so it doesn't look like one.
  const decoded = safeDecodeURIComponent(queryAndFragment);
  const encoded = decoded.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? [];
  if (EMAIL.test(decoded) || encoded.some((token) => EMAIL.test(decodeBase64(token) ?? ""))) {
    raise("identifier_in_url", "the target's email address travels in the URL");
  }
}

const CARD_FIELD = /cc-(?:number|csc|exp)|card|cvv|cvc|expir/i;
const OTP_FIELD = /one-time-code|\botp\b|otp[_-]|2fa|mfa|verification[_-]?code|sms[_-]?code/i;

function formSignals(page: ParsedPage, pageHost: string, raise: Raise) {
  const describe = (input: Record<string, string>) =>
    `${input["name"] ?? ""} ${input["id"] ?? ""} ${input["autocomplete"] ?? ""}`;

  if (page.inputs.some((input) => input["type"]?.toLowerCase() === "password")) {
    raise("password_field", "asks for a password");
  }
  if (page.inputs.some((input) => CARD_FIELD.test(describe(input)))) raise("card_fields", "asks for card details");
  if (page.inputs.some((input) => OTP_FIELD.test(describe(input)))) raise("otp_field", "asks for a one-time code");
  if (asksForSeedPhrase(page, describe)) raise("seed_phrase_request", "asks for a wallet recovery phrase");

  const offsite = new Set<string>();
  for (const form of page.forms) {
    const action = form.action?.trim() ?? "";
    if (action === "" || action === "#" || /^javascript:/i.test(action)) {
      raise("form_without_action", "the form has no destination, so a script must send it");
      continue;
    }
    const host = hostOf(action, pageHost);
    if (host !== null && siteOf(host) !== siteOf(pageHost)) offsite.add(host);
  }
  if (offsite.size > 0) raise("form_posts_offsite", `posts to ${[...offsite].join(", ")}`);
}

const SEED_WORD_FIELD = /\bword[\s_-]*\d{1,2}\b|mnemonic|seed|phrase/i;
const SEED_PHRASE_TEXT = /recovery phrase|seed phrase|secret phrase|mnemonic|\b(?:12|24)[\s-]word/i;
/** A recovery phrase is usually asked for as a grid of 12 or 24 single-word fields. */
const SEED_GRID = 12;

/**
 * Whether the page asks for a wallet recovery phrase: the most valuable thing a crypto
 * wallet lure can steal, since it hands over the wallet itself, not just an account.
 */
function asksForSeedPhrase(page: ParsedPage, describe: (input: Record<string, string>) => string): boolean {
  const wordFields = page.inputs.filter((input) => SEED_WORD_FIELD.test(describe(input))).length;
  if (wordFields >= SEED_GRID) return true;
  return SEED_PHRASE_TEXT.test(`${page.title} ${page.text.join(" ")}`);
}

const OBFUSCATION: ReadonlyArray<[string, RegExp]> = [
  ["eval", /\beval\s*\(/],
  ["atob", /\batob\s*\(/],
  ["fromCharCode", /fromCharCode\s*\(/],
  ["unescape", /\bunescape\s*\(/],
  ["long encoded string", /["'`][A-Za-z0-9+/=]{200,}["'`]|(?:\\x[0-9a-f]{2}){50,}/i],
];

const ANTI_ANALYSIS: ReadonlyArray<[string, RegExp]> = [
  ["blocks the context menu", /contextmenu/i],
  ["blocks developer-tool keys", /keyCode\s*={2,3}\s*123|["']F12["']|ctrlKey[\s\S]{0,40}(?:85|["']u["'])/i],
  ["runs a debugger trap", /\bdebugger\b/],
];

const SENDS = [
  /(?:\bfetch|sendBeacon|\.post|\.get|axios)\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\.open\s*\(\s*["'`][A-Za-z]+["'`]\s*,\s*["'`]([^"'`]+)["'`]/g,
  /new\s+WebSocket\s*\(\s*["'`]([^"'`]+)["'`]/g,
  /\burl\s*:\s*["'`]([^"'`]+)["'`]/g,
];
const REDIRECTS = /location(?:\.href)?\s*=\s*["'`]([^"'`]+)["'`]|location\.(?:replace|assign)\s*\(\s*["'`]([^"'`]+)["'`]/g;

function scriptSignals(page: ParsedPage, pageHost: string, raise: Raise) {
  const code = page.scripts.join("\n");

  const techniques = OBFUSCATION.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  if (techniques.length > 0) raise("obfuscated_script", techniques.join(", "));

  const tricks = ANTI_ANALYSIS.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  if (tricks.length > 0) raise("anti_analysis", tricks.join(", "));

  const redirects = new Set<string>();
  for (const match of code.matchAll(REDIRECTS)) {
    const target = match[1] ?? match[2];
    const host = target ? hostOf(target, pageHost) : null;
    if (host !== null && host !== pageHost) redirects.add(host);
  }
  if (redirects.size > 0) raise("script_redirect", `sends the visitor to ${[...redirects].join(", ")}`);

  // Messaging-bot APIs are a favourite exfiltration channel: no server of the kit's own needed.
  if (/\/bot[^/\s"'`]+\/send(?:Message|Document|Photo)/i.test(code)) {
    raise("bot_api_exfil", "sends data through a messaging-bot API");
  }

  const receivers = new Set<string>();
  for (const pattern of SENDS) {
    for (const [, target] of code.matchAll(pattern)) {
      const host = target ? hostOf(target, pageHost) : null;
      if (host !== null && siteOf(host) !== siteOf(pageHost)) receivers.add(host);
    }
  }
  if (receivers.size > 0) raise("script_sends_offsite", `sends data to ${[...receivers].join(", ")}`);

  for (const meta of page.metas) {
    if (meta["http-equiv"]?.toLowerCase() !== "refresh") continue;
    const target = /url\s*=\s*['"]?([^'";\s]+)/i.exec(meta["content"] ?? "")?.[1];
    const host = target ? hostOf(target, pageHost) : null;
    if (host !== null) raise("meta_refresh", `refreshes to ${host}`);
  }
}

const GENERIC_TITLE_PART = /^(?:sign[\s-]?in|log[\s-]?in|login|verify|verification|account|welcome|home|secure|security|update|confirm)\b/i;
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "of", "bank", "banking", "online", "login", "secure", "account", "service", "services",
  "inc", "ltd", "llc", "group", "plc", "portal", "mail", "web",
]);
const URGENCY = /suspended|unusual activity|within \d+ hours|will be (?:locked|closed|suspended)|confirm your identity|security alert|immediately|limited access/i;
const LOGIN = /sign[\s-]?in|log[\s-]?in|\bpassword\b/i;
const HUMAN_CHECK = /verify you are human|not a robot|human verification|captcha|security check/i;

/** Signals from what the page says and shows: brand, urgency, login and human-check prompts, assets, frames. */
function contentSignals(page: ParsedPage, pageHost: string, raise: Raise) {
  brandSignals(page, pageHost, raise);

  const text = `${page.title} ${page.text.join(" ")}`;
  const urgency = URGENCY.exec(text);
  if (urgency) raise("urgency_language", urgency[0]);
  if (LOGIN.test(text)) raise("login_prompt", "asks the visitor to sign in");
  if (HUMAN_CHECK.test(text)) raise("captcha_gate", "puts a human check in front of the page");

  const assetHosts = new Set<string>();
  const assets = [
    ...page.images,
    ...page.links.filter((link) => /icon|stylesheet/i.test(link["rel"] ?? "")).map((link) => link["href"] ?? ""),
  ];
  for (const asset of assets) {
    if (/^data:/i.test(asset.trim())) continue;
    const host = hostOf(asset, pageHost);
    if (host !== null && siteOf(host) !== siteOf(pageHost)) assetHosts.add(host);
  }
  if (assetHosts.size > 0) raise("hotlinked_assets", `loads assets from ${[...assetHosts].join(", ")}`);
  if (page.images.some((src) => /^data:image\//i.test(src.trim()))) raise("data_uri_images", "embeds images inline");

  const hidden = page.iframes.find(
    (frame) =>
      frame["width"] === "0" ||
      frame["height"] === "0" ||
      /display\s*:\s*none|visibility\s*:\s*hidden/i.test(frame["style"] ?? ""),
  );
  if (hidden) raise("hidden_iframe", `hidden frame to ${hostOf(hidden["src"] ?? "", pageHost) ?? "nowhere"}`);

  if (page.metas.some((meta) => meta["name"]?.toLowerCase() === "robots" && /noindex/i.test(meta["content"] ?? ""))) {
    raise("noindex", "asks search engines not to index it");
  }
}

/** Names the organisation the page claims to be, and flags it when that name appears nowhere in the host. */
function brandSignals(page: ParsedPage, pageHost: string, raise: Raise) {
  const claim = claimedName(page);
  if (claim === null) return;
  raise("brand_claim", claim);

  const words = claim
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_NAME_WORDS.has(word));
  if (words.length === 0 || words.some((word) => pageHost.includes(word))) return;
  raise("brand_host_mismatch", `claims to be "${claim}" on ${pageHost}`);
}

/** The organisation a page claims to be, from its title or its logo, if it names one. */
function claimedName(page: ParsedPage): string | null {
  const siteName = page.metas.find((meta) => meta["property"] === "og:site_name")?.["content"];
  const candidates = [
    siteName,
    ...page.title.split(/\s+[|\-–—:•·]\s+/),
    ...page.logoAlts.map((alt) => alt.replace(/\blogo\b/i, "")),
  ];
  for (const candidate of candidates) {
    const name = candidate?.trim();
    if (name && /[A-Za-z]/.test(name) && !GENERIC_TITLE_PART.test(name)) return name;
  }
  return null;
}

function excerptOf(page: ParsedPage): string {
  const text = [page.title, ...page.text].join(" ").replace(/\s+/g, " ").trim();
  return text.length <= EXCERPT_LIMIT ? text : `${text.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function bounded(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length <= DETAIL_LIMIT ? flat : `${flat.slice(0, DETAIL_LIMIT - 1)}…`;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
