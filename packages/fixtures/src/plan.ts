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
 * From here on, ground truth lags the decision. Before this point labels land at once so the
 * record builds; after it, blocks accumulate unreviewed and the cap of 3 starts to bind —
 * which is the only way a demo shows the mechanism that bounds the damage.
 */
const REVIEW_LAG_FROM = 95;
/**
 * And catches up here. If review lagged all the way to the traps the cap would still be full
 * when they arrived, every one would queue for a person, and the run would end with nothing
 * to revoke — so the backlog drains first.
 */
const REVIEW_LAG_UNTIL = 115;
/** How far review runs behind while it lags. Enough that the cap binds and pages queue. */
const REVIEW_LAG = 5;

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

  const earningPhase = before.map((fixture, index) => ({
    fixture,
    labelDelay: index >= REVIEW_LAG_FROM && index < REVIEW_LAG_UNTIL ? REVIEW_LAG : 0,
  }));

  return [
    ...earningPhase,
    ...traps.map((fixture) => ({ fixture, labelDelay: TRAP_LABEL_DELAY })),
    ...tail.map((fixture) => ({ fixture, labelDelay: 0 })),
  ];
}
