import { env } from "cloudflare:test";
import type { Fixture } from "@warden/fixtures";
import { describe, expect, it } from "vitest";
import { runBatch, START, type DemoLedger, type DemoStep, type RunProgress } from "../src/demo";
import type { Model } from "../src/inference/classify";
import type { Scope } from "../src/ledger";

const SCOPE: Scope = {
  abuseType: "phishing",
  action: "block_url",
  modelId: "@cf/test/model",
  promptHash: "prompt-a",
  policyHash: "policy-a",
};

const page = (id: string, truth: Fixture["truth"]): Fixture => ({
  id,
  url: `https://${id}.northwind.example/login`,
  html: `<title>Northwind Bank</title><form action="/next"><input type="password"></form>`,
  truth,
  labelledBy: "maintainer",
  category: truth === "phishing" ? "credential_harvest" : "hard_negative",
  campaign: "test",
  provenance: null,
});
const steps = (fixtures: Fixture[], labelDelay = 0): DemoStep[] => fixtures.map((fixture) => ({ fixture, labelDelay }));

type Answer = "phishing" | "not_phishing" | "uncertain" | "garbage";
/** A stand-in for Workers AI, deciding by URL, optionally answering after a delay. */
const model = (answer: (url: string) => Answer, delayMs: (url: string) => number = () => 0): Model => ({
  id: SCOPE.modelId,
  async complete(request) {
    const url = JSON.parse(request.messages[1]!.content.replace(/^<untrusted_page>\n|\n<\/untrusted_page>$/g, "")).url as string;
    await new Promise((resolve) => setTimeout(resolve, delayMs(url)));
    const verdict = answer(url);
    if (verdict === "garbage") return "I think this is phishing.";
    return JSON.stringify({
      verdict,
      confidence: 0.9,
      evidence: verdict === "phishing" ? ["password_field"] : [],
      reasoning: "test",
    });
  },
});
const alwaysPhishing = model(() => "phishing");

async function demoLedger() {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`demo:${crypto.randomUUID()}`));
  await stub.open("demo", SCOPE);
  const port: DemoLedger = {
    epoch: async () => (await stub.state())!.permission.epoch,
    submit: (input) => stub.submit(input),
    label: (input) => stub.label(input),
  };
  return { stub, port };
}

async function runToEnd(port: DemoLedger, m: Model, plan: DemoStep[], batchSize: number): Promise<RunProgress> {
  let progress = START;
  for (let guard = 0; !progress.done && guard < 1000; guard++) {
    progress = await runBatch(port, m, SCOPE, plan, progress, batchSize);
  }
  return progress;
}

describe("runBatch", () => {
  it("submits pages in plan order, even when their verdicts come back out of order", async () => {
    const { stub, port } = await demoLedger();
    const plan = steps(["p0", "p1", "p2", "p3"].map((id) => page(id, "phishing")));
    const slowFirst = model(() => "phishing", (url) => (url.includes("p0") ? 30 : url.includes("p1") ? 20 : 0));

    await runBatch(port, slowFirst, SCOPE, plan, START, 4);

    expect((await stub.state())!.decisions.map((decision) => decision.url)).toEqual(plan.map((step) => step.fixture.url));
  });

  it("labels each decision from its page's ground truth: right when the verdict matches it, wrong when not", async () => {
    const { stub, port } = await demoLedger();
    const plan = steps([page("real-phish", "phishing"), page("hard-negative", "legitimate")]);

    await runToEnd(port, alwaysPhishing, plan, 2);
    const state = (await stub.state())!;

    expect(state.decisions.map((decision) => decision.label)).toEqual(["right", "wrong"]);
    expect(state.permission).toMatchObject({ right: 1, wrong: 1 });
  });

  it("leaves uncertain and rejected decisions unlabelled, since they never count", async () => {
    const { stub, port } = await demoLedger();
    const plan = steps([page("unsure", "phishing"), page("broken", "phishing")]);
    const answers = model((url) => (url.includes("unsure") ? "uncertain" : "garbage"));

    await runToEnd(port, answers, plan, 2);

    expect((await stub.state())!.decisions.map((decision) => decision.label)).toEqual([null, null]);
  });

  it("holds a delayed label back until its step comes round, then applies it", async () => {
    const { stub, port } = await demoLedger();
    const plan: DemoStep[] = [
      { fixture: page("late", "phishing"), labelDelay: 2 },
      ...steps([page("b", "phishing"), page("c", "phishing")]),
    ];

    const afterTwo = await runBatch(port, alwaysPhishing, SCOPE, plan, START, 2);
    expect((await stub.state())!.decisions[0]!.label).toBeNull();
    expect(afterTwo.pending).toHaveLength(1);

    await runBatch(port, alwaysPhishing, SCOPE, plan, afterTwo, 2);
    expect((await stub.state())!.decisions[0]!.label).toBe("right");
  });

  it("reads the epoch once per batch before asking the model, so decisions raced by a revocation arrive stale", async () => {
    const { stub, port } = await demoLedger();
    await runToEnd(port, alwaysPhishing, steps(Array.from({ length: 83 }, (_, n) => page(`earn-${n}`, "phishing"))), 20);
    expect((await stub.state())!.permission.state).toBe("AUTONOMOUS");

    // The trap is blocked and found wrong at once; the next page was classified in the same batch.
    const plan = steps([page("trap", "legitimate"), page("raced", "phishing")]);
    await runBatch(port, alwaysPhishing, SCOPE, plan, START, 2);
    const [trap, raced] = (await stub.state())!.decisions.slice(-2);

    expect(trap).toMatchObject({ route: { to: "block" }, label: "wrong" });
    expect(raced).toMatchObject({ route: { to: "human", reason: "stale_epoch" } });
  });

  it("finishes once every page is submitted and every held label applied", async () => {
    const { stub, port } = await demoLedger();
    const plan: DemoStep[] = [{ fixture: page("only", "phishing"), labelDelay: 5 }];

    const progress = await runToEnd(port, alwaysPhishing, plan, 3);

    expect(progress).toEqual({ next: 1, pending: [], done: true });
    expect((await stub.state())!.decisions[0]!.label).toBe("right");
  });

  it("gives the same result however the run is split into batches", async () => {
    const plan = steps(["a", "b", "c", "d", "e"].map((id) => page(id, id === "c" ? "legitimate" : "phishing")));
    const inOne = await demoLedger();
    const inPieces = await demoLedger();

    await runToEnd(inOne.port, alwaysPhishing, plan, 5);
    await runToEnd(inPieces.port, alwaysPhishing, plan, 2);

    const summary = async (stub: typeof inOne.stub) =>
      (await stub.state())!.decisions.map(({ url, route, label }) => ({ url, route, label }));
    expect(await summary(inPieces.stub)).toEqual(await summary(inOne.stub));
  });
});
