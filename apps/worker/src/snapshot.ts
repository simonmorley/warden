/** As much of a page as Warden will read. Enough for any real page; far short of a problem. */
export const MAX_SNAPSHOT_BYTES = 512_000;
/** How many hops to follow. Phishing uses redirect chains, but not endless ones. */
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

export type SnapshotResult =
  | { readonly ok: true; readonly html: string; readonly finalUrl: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetches a reported page so Warden can judge it from a URL alone.
 *
 * The URL comes from whoever reported it, so it is treated as hostile input rather than an
 * address: it may point inwards, redirect inwards part-way, serve something enormous, or
 * serve something that isn't a page at all. Each of those is refused by name, so a caller
 * can be told what happened instead of being handed a blank.
 *
 * A plain fetch sees the HTML as served. It does not run scripts, and a kit that serves
 * benign content to datacentre addresses will show it something harmless — Browser Rendering
 * is the answer to both, and is not built here.
 */
export async function fetchSnapshot(
  url: string,
  {
    fetcher = fetch,
    timeoutMs = TIMEOUT_MS,
    selfOrigin,
  }: { fetcher?: typeof fetch; timeoutMs?: number; selfOrigin?: string } = {},
): Promise<SnapshotResult> {
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = allowedUrl(target, selfOrigin);
    if (!checked.ok) return checked;

    let response: Response;
    try {
      response = await fetcher(checked.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Warden/0.1 (phishing triage)" },
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, checked.url).toString();
      continue;
    }
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };

    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml|text\/plain/i.test(type)) return { ok: false, reason: "not_html" };

    return { ok: true, html: await readBounded(response), finalUrl: checked.url };
  }
  return { ok: false, reason: "too_many_redirects" };
}

/**
 * Accepts an https URL naming somewhere on the public internet, or this Worker's own origin.
 *
 * The exception is narrow and deliberate: the example pages are served by this Worker, and
 * run locally that means plain http on loopback, which the guard is otherwise right to
 * refuse. It is one exact origin, so nothing else on the same machine is reachable.
 */
function allowedUrl(candidate: string, selfOrigin?: string): { ok: true; url: string } | { ok: false; reason: string } {
  if (selfOrigin) {
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === selfOrigin && !parsed.username && !parsed.password) {
        return { ok: true, url: parsed.toString() };
      }
    } catch {
      return { ok: false, reason: "unsupported_url" };
    }
  }
  return publicHttpsUrl(candidate);
}

/** Accepts only an https URL that names somewhere on the public internet. */
function publicHttpsUrl(candidate: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "unsupported_url" };
  }
  // Credentials in a URL would be sent to whatever it resolves to, which the reporter chose.
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { ok: false, reason: "unsupported_url" };
  }
  if (!isPublicHost(parsed.hostname)) return { ok: false, reason: "not_public" };
  return { ok: true, url: parsed.toString() };
}

const PRIVATE_V4 =
  /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** Whether a host is somewhere on the public internet, rather than this machine or a private network. */
function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  // IPv6 literals arrive in brackets; refuse them all rather than reason about the ranges.
  if (host.startsWith("[")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return !PRIVATE_V4.test(host);
  return host.includes(".");
}

/** Reads at most MAX_SNAPSHOT_BYTES, so an enormous response can't be pulled into memory. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_SNAPSHOT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});

  const joined = new Uint8Array(Math.min(total, MAX_SNAPSHOT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = joined.length - offset;
    if (room <= 0) break;
    joined.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.length, room);
  }
  return new TextDecoder().decode(joined);
}
