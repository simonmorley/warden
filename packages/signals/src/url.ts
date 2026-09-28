export interface ParsedUrl {
  readonly scheme: string;
  readonly host: string;
  readonly port: string | null;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

const ABSOLUTE = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** Parses an absolute URL, or returns null. Pure, so it can't lean on the platform's URL class. */
export function parseUrl(url: string): ParsedUrl | null {
  const match = ABSOLUTE.exec(url.trim());
  if (!match) return null;
  const [, scheme = "", host = "", port, path = "", query = "", fragment = ""] = match;
  if (host === "") return null;
  return {
    scheme: scheme.toLowerCase(),
    host: host.toLowerCase(),
    port: port ?? null,
    path,
    query,
    fragment,
  };
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

/**
 * A page's identity: lowercase scheme and host, default port and fragment dropped
 * (PRD 4). Deduplication and reversal both key on it, so it is computed in one place.
 */
export function pageIdentity(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed || !(parsed.scheme in DEFAULT_PORTS)) {
    throw new RangeError(`not an absolute http(s) URL: ${url.slice(0, 80)}`);
  }
  const port = parsed.port !== null && parsed.port !== DEFAULT_PORTS[parsed.scheme] ? `:${parsed.port}` : "";
  return `${parsed.scheme}://${parsed.host}${port}${parsed.path || "/"}${parsed.query}`;
}

/** The host a reference points at, resolving relative references against the page. */
export function hostOf(reference: string, pageHost: string): string | null {
  const trimmed = reference.trim();
  if (trimmed.startsWith("//")) return parseUrl(`https:${trimmed}`)?.host ?? null;
  const parsed = parseUrl(trimmed);
  if (parsed) return parsed.host;
  // javascript:, data:, mailto: and friends point at no host at all.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return pageHost;
}

/**
 * Free hosting and developer platforms where each customer gets a subdomain. Phishing
 * leans on them heavily, and they act as public suffixes: two projects on the same
 * platform are two unrelated sites.
 */
export const FREE_HOSTING = [
  "pages.dev", "workers.dev", "vercel.app", "netlify.app", "github.io", "gitlab.io", "firebaseapp.com",
  "web.app", "blogspot.com", "weebly.com", "weeblysite.com", "godaddysites.com", "wixsite.com",
  "webflow.io", "framer.app", "framer.website", "replit.app", "repl.co", "glitch.me", "azurewebsites.net",
  "herokuapp.com", "onrender.com", "edgeone.dev", "jimdofree.com", "square.site", "carrd.co",
  "surge.sh", "fly.dev", "notion.site",
];

export function freeHostingPlatform(host: string): string | null {
  return FREE_HOSTING.find((platform) => host === platform || host.endsWith(`.${platform}`)) ?? null;
}

/**
 * An approximation of "the same site" without the Public Suffix List: the last two labels,
 * or one label plus the platform on free hosting. Wrong for suffixes like co.uk, which
 * a production system would take from the list.
 */
export function siteOf(host: string): string {
  const platform = freeHostingPlatform(host);
  if (platform !== null && host !== platform) {
    const prefix = host.slice(0, -platform.length - 1).split(".");
    return `${prefix[prefix.length - 1]}.${platform}`;
  }
  return host.split(".").slice(-2).join(".");
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}
