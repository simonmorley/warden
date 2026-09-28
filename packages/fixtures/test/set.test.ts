import { describe, expect, it } from "vitest";
import { ALL_FIXTURES, checkFixture, SEEDS, type Category, type Fixture } from "../src/index";

const phishing = ALL_FIXTURES.filter((fixture) => fixture.truth === "phishing");
const legitimate = ALL_FIXTURES.filter((fixture) => fixture.truth === "legitimate");
const withCategory = (category: Category) => ALL_FIXTURES.filter((fixture) => fixture.category === category);

describe("the fixture set is safe to publish", () => {
  it.each(ALL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))("%s passes the safety check", (_id, fixture) => {
    expect(checkFixture(fixture)).toEqual([]);
  });

  it("gives every fixture a unique id, since the ledger keys decisions by page", () => {
    const ids = ALL_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every fixture a unique URL, so nothing is a duplicate by accident", () => {
    const urls = ALL_FIXTURES.map((fixture) => fixture.url);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("the set covers what the design depends on", () => {
  it.each([
    "credential_harvest",
    "card_capture",
    "redirect_chain",
    "obfuscated",
    "hard_negative",
    "benign",
    "ambiguous",
    "weaponised_report",
    "evasion",
  ] as const)("includes at least one %s page", (category) => {
    expect(withCategory(category).length).toBeGreaterThan(0);
  });

  it("carries more than one weaponised report, so a model that resists the first meets another", () => {
    expect(withCategory("weaponised_report").length).toBeGreaterThanOrEqual(3);
  });

  it("labels every weaponised report legitimate, because that is the point of the trap", () => {
    for (const trap of withCategory("weaponised_report")) expect(trap.truth).toBe("legitimate");
  });

  it("labels every evasion page phishing, because that is the point of the evasion", () => {
    for (const evasion of withCategory("evasion")) expect(evasion.truth).toBe("phishing");
  });

  it("has enough phishing pages to reach AUTONOMOUS, with headroom for mistakes and rejections", () => {
    // 73 clean labels clear the bar, 10 more pass probation, and the run needs room
    // for uncertain answers, rejections and the mistakes that push the target out.
    expect(phishing.length).toBeGreaterThanOrEqual(140);
  });

  it("has enough legitimate pages for the false-positive path to be exercised", () => {
    expect(legitimate.length).toBeGreaterThanOrEqual(10);
  });
});

describe("campaign siblings", () => {
  const byCampaign = new Map<string, Fixture[]>();
  for (const fixture of phishing) {
    byCampaign.set(fixture.campaign, [...(byCampaign.get(fixture.campaign) ?? []), fixture]);
  }
  const families = [...byCampaign.values()].filter((family) => family.length > 1);

  it("has campaigns with more than one page, as real ones occupy many domains", () => {
    expect(families.length).toBeGreaterThan(0);
  });

  it.each(families.map((family) => [family[0]!.campaign, family] as const))(
    "gives %s siblings distinct hosts and distinct content",
    (_campaign, family) => {
      const hosts = family.map((fixture) => new URL(fixture.url).host);
      const bodies = family.map((fixture) => fixture.html);
      expect(new Set(hosts).size).toBe(family.length);
      expect(new Set(bodies).size).toBe(family.length);
    },
  );

  it("keeps every sibling's label the same as its seed's", () => {
    for (const family of families) {
      const truths = new Set(family.map((fixture) => fixture.truth));
      expect(truths.size).toBe(1);
    }
  });
});

describe("seeds", () => {
  it("are all written by a person, and say which survey prompted them", () => {
    for (const seed of SEEDS) {
      expect(seed.labelledBy).not.toBeNull();
      expect(seed.provenance?.survey).toBeTruthy();
    }
  });

  it("are few enough to read, because every one is hand-written", () => {
    expect(SEEDS.length).toBeLessThanOrEqual(25);
  });

  it("exhibit the signals their technique is named for", () => {
    // A schematic page has to actually carry its technique, or the set proves nothing.
    expect(SEEDS.find((seed) => seed.id.includes("wallet-recovery"))?.html).toMatch(/word1/);
    expect(SEEDS.find((seed) => seed.id.includes("card"))?.html).toMatch(/cc-number|card/i);
  });
});
