import { familyOf } from "./generate";
import { LEGITIMATE_SEEDS } from "./seeds/legitimate";
import { PHISHING_SEEDS } from "./seeds/phishing";
import type { Fixture } from "./types";

export type * from "./types";
export { checkFixture } from "./safety";
export { familyOf, VARIANTS_PER_SEED, variantsOf } from "./generate";

/** Every hand-written seed. Each is one technique; the rest of the set is generated from these. */
export const SEEDS: readonly Fixture[] = [...PHISHING_SEEDS, ...LEGITIMATE_SEEDS];

/**
 * The whole set: each phishing seed with its campaign siblings, then the legitimate pages,
 * which stay one of a kind because a false positive is about this page, not a family.
 */
export const ALL_FIXTURES: readonly Fixture[] = [
  ...PHISHING_SEEDS.flatMap((seed) => familyOf(seed)),
  ...LEGITIMATE_SEEDS,
];
