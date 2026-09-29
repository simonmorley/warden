import { DEFAULT_POLICY, type Label, type Verdict } from "@warden/engine";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluation";
import type { DecisionSummary } from "../src/ledger";

let next = 0;
/** A decision as the ledger reports it, reduced to what an evaluation reads. */
function decision(verdict: Verdict, label: Label | null, extra: Partial<DecisionSummary> = {}): DecisionSummary {
  const valid = extra.valid ?? true;
  return {
    id: `d${next++}`,
    url: `https://page-${next}.example/`,
    verdict,
    valid,
    rejection: valid ? null : "schema",
    citedSignals: [],
    confidence: null,
    counted: verdict === "phishing" && valid,
    route: { to: "human", reason: "shadow" },
    block: null,
    label,
    createdAt: 0,
    ...extra,
  };
}
const times = (count: number, make: () => DecisionSummary) => Array.from({ length: count }, make);

describe("evaluate", () => {
  it("says not yet about a run with nothing judged, rather than a number made of nothing", () => {
    expect(evaluate([], DEFAULT_POLICY)).toMatchObject({
      qualification: "not_yet",
      phishingCalls: { right: 0, wrong: 0, measured: null, lower: null, upper: null },
    });
  });

  it("measures the phishing calls the bar is measured on, with the interval around them", () => {
    const decisions = [...times(72, () => decision("phishing", "right")), ...times(8, () => decision("phishing", "wrong"))];
    const { phishingCalls, qualification } = evaluate(decisions, DEFAULT_POLICY);

    expect(phishingCalls).toMatchObject({ right: 72, wrong: 8, measured: 0.9 });
    expect(phishingCalls.lower!).toBeLessThan(0.9);
    expect(phishingCalls.upper!).toBeGreaterThan(0.9);
    expect(qualification).toBe("unqualifiable");
  });

  it("clears a configuration whose phishing calls clear the bar", () => {
    expect(evaluate(times(73, () => decision("phishing", "right")), DEFAULT_POLICY).qualification).toBe("clears");
  });

  // A demo ledger's permission restarts at zero on revocation. The configuration's evidence
  // doesn't: every page it judged is evidence about it, whichever epoch the ledger was in.
  it("counts every epoch, because the configuration is judged on the whole corpus", () => {
    const decisions = [
      ...times(40, () => decision("phishing", "right", { route: { to: "human", reason: "shadow" } })),
      ...times(33, () => decision("phishing", "right", { route: { to: "human", reason: "stale_epoch" } })),
    ];
    expect(evaluate(decisions, DEFAULT_POLICY).phishingCalls.right).toBe(73);
  });

  it("leaves out what the bar leaves out: legitimate calls, unsure ones, rejected ones and duplicates", () => {
    const decisions = [
      decision("not_phishing", "right"),
      decision("uncertain", null),
      decision("phishing", null, { valid: false }),
      decision("phishing", "right", { counted: false }),
      decision("phishing", "right"),
    ];
    expect(evaluate(decisions, DEFAULT_POLICY).phishingCalls).toMatchObject({ right: 1, wrong: 0 });
  });

  it("does not count a phishing call nobody has judged yet", () => {
    expect(evaluate([decision("phishing", null)], DEFAULT_POLICY).phishingCalls).toMatchObject({ right: 0, wrong: 0 });
  });

  it("reports every verdict too, so missed phishing and unusable answers stay visible", () => {
    const decisions = [
      decision("phishing", "right"),
      decision("not_phishing", "right"),
      decision("not_phishing", "wrong"),
      decision("uncertain", null),
      decision("phishing", null, { valid: false }),
    ];
    expect(evaluate(decisions, DEFAULT_POLICY).allCalls).toEqual({
      classified: 5,
      judged: 3,
      right: 2,
      missedPhishing: 1,
      unusable: 2,
    });
  });
});
