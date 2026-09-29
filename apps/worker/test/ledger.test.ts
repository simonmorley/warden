import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Scope, SubmitInput } from "../src/ledger";

const SCOPE: Scope = {
  abuseType: "phishing",
  action: "block_url",
  modelId: "@cf/test/model",
  promptHash: "prompt-a",
  policyHash: "policy-a",
};

const ledger = (name = `demo:${crypto.randomUUID()}`) => env.LEDGER.get(env.LEDGER.idFromName(name));
type LedgerStub = ReturnType<typeof ledger>;

const phishing = (n: number, overrides: Partial<SubmitInput> = {}): SubmitInput => ({
  page: { identity: `https://login.bank-${n}.example/`, url: `https://login.bank-${n}.example/`, contentHash: `hash-${n}` },
  verdict: "phishing",
  valid: true,
  rejection: null,
  citedSignals: ["S1"],
  confidence: 0.9,
  rawResponse: "{}",
  epochSeen: 1,
  scope: SCOPE,
  ...overrides,
});

async function submitted(stub: LedgerStub, input: SubmitInput) {
  const result = await stub.submit(input);
  if (!result.ok) throw new Error(`submit refused: ${result.error}`);
  return result;
}

/** Earns AUTONOMOUS the only way there is: 73 correct labels, then 10 checks of probation. */
async function earnAutonomy(stub: LedgerStub) {
  for (let n = 0; n < 83; n++) {
    const { decisionId } = await submitted(stub, phishing(n));
    await stub.label({ decisionId, label: "right", source: "ground_truth", labelledBy: "fixture" });
  }
  const state = await stub.state();
  expect(state?.permission.state).toBe("AUTONOMOUS");
}

describe("Ledger: opening", () => {
  it("opens in SHADOW with its kind and scope, and reopening with the same ones changes nothing", async () => {
    const stub = ledger();

    const first = await stub.open("demo", SCOPE);
    const again = await stub.open("demo", SCOPE);

    expect(first).toEqual({ ok: true, permission: expect.objectContaining({ state: "SHADOW", epoch: 1 }) });
    expect(again).toEqual(first);
    expect(await stub.state()).toMatchObject({ kind: "demo", scope: SCOPE });
  });

  it("refuses to reopen as a different kind or scope", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);

    expect(await stub.open("live", SCOPE)).toEqual({ ok: false, error: "kind_mismatch" });
    expect(await stub.open("demo", { ...SCOPE, promptHash: "prompt-b" })).toEqual({ ok: false, error: "scope_mismatch" });
  });

  it("refuses work before it has been opened", async () => {
    const stub = ledger();

    expect(await stub.state()).toBeNull();
    expect(await stub.submit(phishing(1))).toEqual({ ok: false, error: "not_open" });
  });
});

describe("Ledger: decisions", () => {
  it("records a submission and routes it through the engine", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);

    const result = await submitted(stub, phishing(1));

    expect(result).toMatchObject({ route: { to: "human", reason: "shadow" }, counted: true, epoch: 1 });
    expect((await stub.state())?.decisions).toEqual([
      {
        id: result.decisionId,
        url: "https://login.bank-1.example/",
        verdict: "phishing",
        valid: true,
        rejection: null,
        citedSignals: ["S1"],
        confidence: 0.9,
        counted: true,
        route: { to: "human", reason: "shadow" },
        block: null,
        label: null,
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("shows what happened to each decision's block: active until it is reversed", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);
    const kept = await submitted(stub, phishing(100));
    const undone = await submitted(stub, phishing(101));
    await stub.label({ decisionId: undone.decisionId, label: "wrong", source: "ground_truth", labelledBy: "fixture" });

    const decisions = (await stub.state())!.decisions;
    const blockOf = (id: string) => decisions.find((decision) => decision.id === id)?.block;

    expect(blockOf(kept.decisionId)).toBe("active");
    expect(blockOf(undone.decisionId)).toBe("reversed");
  });

  it("refuses a verdict produced under a different scope: it belongs to a different permission", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);

    const result = await stub.submit(phishing(1, { scope: { ...SCOPE, promptHash: "prompt-b" } }));

    expect(result).toEqual({ ok: false, error: "scope_mismatch" });
    expect((await stub.state())?.decisions).toEqual([]);
  });

  it("treats the same page submitted twice as one data point", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);

    await submitted(stub, phishing(1));
    const repeat = await submitted(stub, phishing(1));

    expect(repeat).toMatchObject({ route: { to: "human", reason: "duplicate" }, counted: false });
  });
});

describe("Ledger: blocking", () => {
  it("creates the block in the same call that authorises it", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);

    const result = await submitted(stub, phishing(100));
    const state = await stub.state();

    expect(result.route).toEqual({ to: "block" });
    expect(state?.blocklist).toEqual([
      { url: "https://login.bank-100.example/", decisionId: result.decisionId, epoch: 1, createdAt: expect.any(Number) },
    ]);
    expect(state?.permission.unreviewed).toBe(1);
  });

  it("holds the cap when submissions arrive together", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);

    const results = await Promise.all([100, 101, 102, 103, 104, 105].map((n) => submitted(stub, phishing(n))));
    const routes = results.map((result) => result.route);

    expect(routes.filter((route) => route.to === "block")).toHaveLength(3);
    expect(routes.filter((route) => route.to === "human" && route.reason === "cap_full")).toHaveLength(3);
    expect((await stub.state())?.blocklist).toHaveLength(3);
  });
});

describe("Ledger: labels", () => {
  it("applies a label once: an identical repeat is a no-op, a conflicting one is refused", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    const { decisionId } = await submitted(stub, phishing(1));
    const label = { decisionId, label: "right", source: "ground_truth", labelledBy: "fixture" } as const;

    const first = await stub.label(label);
    const repeat = await stub.label(label);
    const conflicting = await stub.label({ ...label, label: "wrong" });

    expect(first).toMatchObject({ ok: true, applied: true, permission: { right: 1 } });
    expect(repeat).toMatchObject({ ok: true, applied: false, permission: { right: 1 } });
    expect(conflicting).toEqual({ ok: false, error: "label_conflict" });
    expect((await stub.state())?.permission).toMatchObject({ right: 1, wrong: 0 });
  });

  it("refuses a label for a decision it has never seen", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);

    expect(await stub.label({ decisionId: "nope", label: "right", source: "ground_truth", labelledBy: "fixture" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("lets only a human label the live ledger", async () => {
    const stub = ledger("live:test");
    await stub.open("live", SCOPE);
    const { decisionId } = await submitted(stub, phishing(1));

    const fromFixture = await stub.label({ decisionId, label: "right", source: "ground_truth", labelledBy: "fixture" });
    const fromHuman = await stub.label({ decisionId, label: "right", source: "human", labelledBy: "analyst" });

    expect(fromFixture).toEqual({ ok: false, error: "ground_truth_refused" });
    expect(fromHuman).toMatchObject({ ok: true, applied: true });
  });
});

describe("Ledger: losing permission", () => {
  it("revokes and reverses a wrong automatic block: the URL leaves the blocklist, and both events are recorded", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);
    const trap = await submitted(stub, phishing(100));

    const caught = await stub.label({ decisionId: trap.decisionId, label: "wrong", source: "ground_truth", labelledBy: "fixture" });
    const state = await stub.state();

    expect(caught).toMatchObject({ ok: true, applied: true, reversedUrl: "https://login.bank-100.example/" });
    expect(state?.permission).toMatchObject({ state: "SHADOW", epoch: 2, right: 0, wrong: 0, unreviewed: 0 });
    expect(state?.blocklist).toEqual([]);
    expect(state?.events.slice(-2).map((recorded) => recorded.event.kind)).toEqual(["revoked", "reversed"]);
    expect(state?.events.slice(-2).every((recorded) => recorded.decisionId === trap.decisionId)).toBe(true);
  });

  it("refuses an automatic block to a caller that saw the epoch before a revocation", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);
    const trap = await submitted(stub, phishing(100));
    await stub.label({ decisionId: trap.decisionId, label: "wrong", source: "ground_truth", labelledBy: "fixture" });

    const stale = await submitted(stub, phishing(101, { epochSeen: 1 }));

    expect(stale.route).toEqual({ to: "human", reason: "stale_epoch" });
  });
});

describe("Ledger: probing", () => {
  it("writes nothing when a ledger that was never opened is read, so probing run ids leaves no litter", async () => {
    const stub = ledger();

    expect(await stub.state()).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray();
      expect(tables).toEqual([]);
    });
  });
});

describe("Ledger: persistence", () => {
  it("keeps everything in storage, so nothing is lost when the object leaves memory", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    const { decisionId } = await submitted(stub, phishing(1));
    await stub.label({ decisionId, label: "wrong", source: "ground_truth", labelledBy: "fixture" });
    const before = await stub.state();

    await evictDurableObject(stub);

    expect(await stub.state()).toEqual(before);
  });
});

// The Review chart replays the record label by label, so it needs the order they were given in.
describe("Ledger: judgements", () => {
  const judge = (stub: LedgerStub, decisionId: string, label: "right" | "wrong") =>
    stub.label({ decisionId, label, source: "ground_truth", labelledBy: "fixture" });

  it("lists every label in the order it was given, not the order the decisions were made", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    const first = await submitted(stub, phishing(1));
    const second = await submitted(stub, phishing(2));

    await judge(stub, second.decisionId, "right");
    await judge(stub, first.decisionId, "wrong");

    const { judgements } = (await stub.state())!;
    expect(judgements).toEqual([
      { decisionId: second.decisionId, label: "right", counted: true, epoch: 1, labelledAt: expect.any(Number) },
      { decisionId: first.decisionId, label: "wrong", counted: true, epoch: 1, labelledAt: expect.any(Number) },
    ]);
  });

  it("says when a judgement could not count, so a replay can leave it out", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    const legitimate = await submitted(stub, phishing(1, { verdict: "not_phishing" }));

    await judge(stub, legitimate.decisionId, "right");

    expect((await stub.state())!.judgements).toEqual([expect.objectContaining({ counted: false })]);
  });

  it("replays to exactly the permission's counts once a revocation has started a new epoch", async () => {
    const stub = ledger();
    await stub.open("demo", SCOPE);
    await earnAutonomy(stub);
    const blocked = await submitted(stub, phishing(100));
    await judge(stub, blocked.decisionId, "wrong");
    for (const n of [101, 102]) {
      const { decisionId } = await submitted(stub, phishing(n, { epochSeen: 2 }));
      await judge(stub, decisionId, "right");
    }

    const { judgements, permission } = (await stub.state())!;
    const current = judgements.filter((judgement) => judgement.counted && judgement.epoch === permission.epoch);

    expect(permission.epoch).toBe(2);
    expect(judgements).toHaveLength(86);
    expect(current.filter((judgement) => judgement.label === "right")).toHaveLength(permission.right);
    expect(current.filter((judgement) => judgement.label === "wrong")).toHaveLength(permission.wrong);
  });
});
