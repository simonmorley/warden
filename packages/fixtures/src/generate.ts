import type { Fixture } from "./types";

/** Variants generated per phishing seed, which with the seeds themselves fills the demo run. */
export const VARIANTS_PER_SEED = 21;

/**
 * A short deterministic token from a seed id and an index. Pure: the set must be identical
 * on every machine and every run, because a fixture id is how a decision is traced back.
 */
function token(seedId: string, index: number): string {
  let hash = 2166136261;
  for (const char of `${seedId}:${index}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

/**
 * Siblings of one seed: the same technique on different infrastructure, as a real campaign
 * appears across many domains. Host, path and exfiltration subdomain all change; the
 * technique, label, category and campaign do not.
 *
 * They are what makes the independence limitation in PRD 6.2 visible: URL-level deduplication
 * counts these as separate evidence, when between them they prove roughly as much as one.
 */
export function variantsOf(seed: Fixture, count: number = VARIANTS_PER_SEED): Fixture[] {
  const [subdomain, ...rest] = hostOf(seed.url).split(".");
  return Array.from({ length: count }, (_, index) => {
    const mark = token(seed.id, index);
    const host = [`${subdomain}-${mark}`, ...rest].join(".");

    return {
      ...seed,
      id: `${seed.id}-${mark}`,
      url: rehost(seed.url, host, mark),
      // The exfiltration subdomain moves with the deployment, as it does in a real kit,
      // and a deployment marker in the source keeps every sibling's content distinct.
      html: seed.html
        .replace(/collect\./g, `collect-${mark}.`)
        .replace("<body>", `<body>\n  <!-- build ${mark} -->`),
      seed: seed.id,
    };
  });
}

/** The host part of an absolute URL. Hand-rolled: this package has no platform globals. */
function hostOf(url: string): string {
  const start = url.indexOf("://") + 3;
  const end = url.indexOf("/", start);
  return end === -1 ? url.slice(start) : url.slice(start, end);
}

/** The same URL on a different host, carrying a deployment marker. */
function rehost(url: string, host: string, ref: string): string {
  const start = url.indexOf("://") + 3;
  const end = url.indexOf("/", start);
  const path = end === -1 ? "/" : url.slice(end);
  const separator = path.includes("?") ? "&" : "?";
  return `${url.slice(0, start)}${host}${path}${separator}ref=${ref}`;
}

/** A seed and its siblings, in order. */
export function familyOf(seed: Fixture, count: number = VARIANTS_PER_SEED): Fixture[] {
  return [seed, ...variantsOf(seed, count)];
}
