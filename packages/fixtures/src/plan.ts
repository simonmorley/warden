import { ALL_FIXTURES } from "./set";
import type { Fixture } from "./types";

/** One page of a demo run, and how long its ground truth waits before being applied. */
export interface DemoStep {
  readonly fixture: Fixture;
  /** Further steps to wait before labelling; 0 labels it straight after its own decision. */
  readonly labelDelay: number;
}

/** Where the first hard negative sits: early, while a mistake still costs only credit. */
const FIRST_MISTAKE_AT = 25;
/** Phishing pages held back for after the traps, so a stale-epoch retry has somewhere to show. */
const TAIL_PAGES = 20;
/** Steps a trap's ground truth waits, so its block is visibly unreviewed before it is judged. */
const TRAP_LABEL_DELAY = 2;

/**
 * The order a demo run walks the set in, built to produce the arc in PRD section 13. The
 * order is fixed; what the model says about each page is not, so two runs differ only by
 * the model's own verdicts.
 *
 * Nothing here asserts an outcome. If the model resists every trap, the run simply ends
 * without a revocation and the dashboard says so.
 */
export function demoPlan(): DemoStep[] {
  const phishing = ALL_FIXTURES.filter((fixture) => fixture.truth === "phishing");
  const traps = ALL_FIXTURES.filter((fixture) => fixture.category === "weaponised_report");
  const hardNegatives = ALL_FIXTURES.filter((fixture) => fixture.category === "hard_negative");
  const quiet = ALL_FIXTURES.filter(
    (fixture) => fixture.category === "ambiguous" || fixture.category === "benign",
  );

  const earning = phishing.slice(0, phishing.length - TAIL_PAGES);
  const tail = phishing.slice(phishing.length - TAIL_PAGES);

  // Everything that isn't phishing and isn't a trap is spread through the earning phase:
  // the hard negatives are where a mistake can happen, the rest simply never count.
  const spread = [...hardNegatives, ...quiet];
  const before: Fixture[] = [...earning];
  before.splice(FIRST_MISTAKE_AT, 0, spread[0]!);
  for (const [offset, fixture] of spread.slice(1).entries()) {
    before.splice(FIRST_MISTAKE_AT + Math.floor((offset + 1) * (earning.length / spread.length)), 0, fixture);
  }

  return [
    ...before.map(immediately),
    ...traps.map((fixture) => ({ fixture, labelDelay: TRAP_LABEL_DELAY })),
    ...tail.map(immediately),
  ];
}

/** A step whose ground truth is applied as soon as the page is decided. */
function immediately(fixture: Fixture): DemoStep {
  return { fixture, labelDelay: 0 };
}
