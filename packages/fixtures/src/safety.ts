import type { Fixture, Violation, ViolationKind } from "./types";

/**
 * The safety check every fixture must pass before it ships in a public repository.
 *
 * Fixtures imitate phishing pages, so each rule closes one way a fixture could do harm
 * if copied out of the repository, or embarrass someone who never agreed to be in it.
 */
export function checkFixture(fixture: Fixture): Violation[] {
  const violations: Violation[] = [];
  const flag = (kind: ViolationKind, detail: string) => violations.push({ kind, fixture: fixture.id, detail });
  const everything = `${fixture.url}\n${fixture.html}`;

  // No live URLs: every name must be one that RFC 2606 and RFC 6761 reserve.
  for (const host of hostsIn(everything)) {
    if (!isReserved(host)) flag("live_url", host);
  }
  for (const host of hostsInProse(provenanceOf(fixture))) {
    if (!isReserved(host)) flag("live_url", `${host} (in provenance)`);
  }

  // No working targets: nothing may send data anywhere that resolves. That includes
  // example.com, which IANA really does serve, so only .invalid will do.
  for (const action of formActions(fixture.html)) {
    const host = hostOf(action);
    if (host !== null && !neverResolves(host)) flag("working_target", `form action ${action}`);
  }
  for (const script of scriptBodies(fixture.html)) {
    for (const host of hostsIn(script)) {
      if (!neverResolves(host)) flag("working_target", `script target ${host}`);
    }
  }

  for (const brand of REAL_BRANDS) {
    if (brand.pattern.test(everything)) flag("real_brand", brand.name);
  }

  for (const [, domain] of everything.matchAll(EMAIL)) {
    if (domain !== undefined && !isReserved(domain)) flag("victim_data", `email address at ${domain}`);
  }
  for (const [candidate] of everything.matchAll(CARD_LIKE)) {
    const digits = candidate.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      flag("victim_data", `card-like number ending ${digits.slice(-4)}`);
    }
  }

  for (const credential of CREDENTIALS) {
    if (credential.pattern.test(everything)) flag("credential", credential.name);
  }

  if (fixture.labelledBy === null || fixture.labelledBy.trim() === "") {
    flag("unconfirmed_label", "no person has confirmed this label");
  }

  return violations;
}

const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["test", "example", "invalid"];

function isReserved(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return (
    RESERVED_TLDS.some((tld) => name === tld || name.endsWith(`.${tld}`)) ||
    RESERVED_DOMAINS.some((domain) => name === domain || name.endsWith(`.${domain}`))
  );
}

function neverResolves(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "invalid" || name.endsWith(".invalid");
}

const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`)\\]+/gi;
// A protocol-relative reference: // followed straight by a dotted name, not preceded by a scheme.
const PROTOCOL_RELATIVE = /(?<![:\w/])\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

function hostOf(url: string): string | null {
  const match = /^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function* hostsIn(text: string): Generator<string> {
  for (const [url] of text.matchAll(ABSOLUTE_URL)) {
    const host = hostOf(url);
    if (host !== null) yield host;
  }
  for (const [, host] of text.matchAll(PROTOCOL_RELATIVE)) {
    if (host !== undefined) yield host.toLowerCase();
  }
}

function* formActions(html: string): Generator<string> {
  for (const [, action] of html.matchAll(/<form\b[^>]*\baction\s*=\s*["']([^"']*)["']/gi)) {
    if (action !== undefined) yield action;
  }
}

function* scriptBodies(html: string): Generator<string> {
  for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (body !== undefined) yield body;
  }
}

/** A fixture's provenance as one string: short, structured text we wrote ourselves. */
function provenanceOf(fixture: Fixture): string {
  if (!fixture.provenance) return "";
  return `${fixture.provenance.survey} ${fixture.provenance.technique}`;
}

/**
 * Host-shaped words in prose, where there is no scheme to anchor on. Deliberately eager:
 * it will flag "Node.js" as a host. In a short provenance note that trade is worth making,
 * because the cost is rewording a sentence and the cost of missing one is a live host in a
 * public repository.
 */
const PROSE_HOST = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/gi;

function* hostsInProse(text: string): Generator<string> {
  for (const [host] of text.matchAll(PROSE_HOST)) yield host.toLowerCase();
}

const EMAIL = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
const CARD_LIKE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;

/** The Luhn checksum every payment card number passes. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i]);
    sum += i % 2 === 1 ? doubledDigit(digit) : digit;
  }
  return sum % 10 === 0;
}

/** Luhn doubles every second digit from the right and sums the result's digits. */
function doubledDigit(digit: number): number {
  const doubled = digit * 2;
  return doubled > 9 ? doubled - 9 : doubled;
}

/**
 * Brands phishing commonly imitates. Matched as whole words, so a fixture can't impersonate
 * a real organisation. Brands that are also everyday words (meta, zoom, steam, ups) are
 * left out to avoid false alarms, and so is "ledger", which is also this project's own term.
 */
const BRAND_NAMES = [
  "paypal", "microsoft", "office 365", "office365", "outlook", "onedrive", "sharepoint", "apple",
  "icloud", "itunes", "google", "gmail", "youtube", "recaptcha", "hcaptcha", "amazon", "aws",
  "netflix", "facebook", "instagram", "whatsapp", "linkedin", "twitter", "tiktok", "snapchat",
  "discord", "telegram", "dhl", "fedex", "usps", "royal mail", "parcelforce", "evri", "hmrc", "irs",
  "dvla", "chase", "wells fargo", "bank of america", "citibank", "citi", "hsbc", "barclays", "lloyds",
  "natwest", "santander", "halifax", "monzo", "revolut", "capital one", "american express", "amex",
  "visa", "mastercard", "coinbase", "binance", "metamask", "trezor", "adobe", "docusign", "dropbox",
  "wetransfer", "roblox", "cloudflare", "at&t", "verizon", "t-mobile", "vodafone", "ebay", "walmart",
  "airbnb", "yahoo", "okta",
];

const REAL_BRANDS = BRAND_NAMES.map((name) => ({
  name,
  pattern: new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?![a-z0-9])`, "i"),
}));

/** Operator credentials that turn up in phishing kits. None may survive into a fixture. */
const CREDENTIALS = [
  { name: "Telegram bot token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Discord webhook", pattern: /\/api\/webhooks\/\d{17,20}\/[\w-]+/ },
  { name: "Stripe live key", pattern: /\bsk_live_[0-9a-zA-Z]{16,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "private key", pattern: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/ },
];
