import { env, runDurableObjectAlarm } from "cloudflare:test";
import type { Fixture } from "@warden/fixtures";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { DemoStep } from "../src/demo";
import type { Model } from "../src/inference/classify";
import type { Scope } from "../src/ledger";

const SCOPE: Scope = {
  abuseType: "phishing",
  action: "block_url",
  modelId: "@cf/test/model",
  promptHash: "prompt-a",
  policyHash: "policy-a",
};
const TOKEN = "test-token";

const fixture = (id: string): Fixture => ({
  id,
  url: `https://${id}.northwind.example/login`,
  html: '<form action="/next"><input type="password"></form>',
  truth: "phishing",
  labelledBy: "maintainer",
  category: "credential_harvest",
  campaign: "test",
  provenance: null,
});
const PLAN: DemoStep[] = ["a", "b", "c"].map((id) => ({ fixture: fixture(id), labelDelay: 0 }));

const demoLedger = () => env.LEDGER.get(env.LEDGER.idFromName(`demo:${crypto.randomUUID()}`));

describe("Ledger: demo runs", () => {
  it("records a started run and schedules its first batch", async () => {
    const stub = demoLedger();
    await stub.open("demo", SCOPE);

    expect(await stub.startRun(PLAN)).toEqual({ ok: true, total: 3 });
    expect((await stub.state())!.run).toEqual({ status: "running", next: 0, total: 3, reason: null });
  });

  it("refuses to start a second run on the same ledger", async () => {
    const stub = demoLedger();
    await stub.open("demo", SCOPE);
    await stub.startRun(PLAN);

    expect(await stub.startRun(PLAN)).toEqual({ ok: false, error: "already_started" });
  });

  it("refuses to run in the live ledger", async () => {
    const stub = env.LEDGER.get(env.LEDGER.idFromName(`live:${crypto.randomUUID()}`));
    await stub.open("live", SCOPE);

    expect(await stub.startRun(PLAN)).toEqual({ ok: false, error: "not_a_demo_ledger" });
  });

  it("fails a run with its reason, rather than stalling, when it cannot classify", async () => {
    const stub = demoLedger();
    // Scoped to a model the Worker isn't configured with, so the run can't honour its scope.
    await stub.open("demo", SCOPE);
    await stub.startRun(PLAN);

    await runDurableObjectAlarm(stub);

    expect((await stub.state())!.run).toMatchObject({
      status: "failed",
      next: 0,
      total: 3,
      reason: expect.stringContaining(SCOPE.modelId),
    });
  });
});

describe("the demo run API", () => {
  const model: Model = { id: SCOPE.modelId, complete: async () => "{}" };
  const app = createApp({ model: () => model, liveLedgerName: () => `live:${crypto.randomUUID()}`, demoPlan: () => PLAN });
  const post = (path: string, token: string | null = TOKEN) =>
    app.fetch(
      new Request(`https://warden.test${path}`, {
        method: "POST",
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
      { ...env, WARDEN_TOKEN: TOKEN },
    );
  const get = (path: string) => app.fetch(new Request(`https://warden.test${path}`), { ...env, WARDEN_TOKEN: TOKEN });

  it("needs the token to start a run, because every run spends real inference", async () => {
    expect((await post("/demo/runs", null)).status).toBe(401);
  });

  it("starts a run on a fresh ledger and reports where to watch it", async () => {
    const res = await post("/demo/runs");
    const { runId, total } = await res.json<{ runId: string; total: number }>();

    expect(res.status).toBe(202);
    expect(total).toBe(3);

    const watched = await get(`/demo/runs/${runId}`);
    expect(watched.status).toBe(200);
    expect(await watched.json()).toMatchObject({ kind: "demo", scope: { modelId: SCOPE.modelId }, run: { status: "running" } });
  });

  it("gives each run its own ledger", async () => {
    const first = await (await post("/demo/runs")).json<{ runId: string }>();
    const second = await (await post("/demo/runs")).json<{ runId: string }>();

    expect(first.runId).not.toBe(second.runId);
  });

  it("says plainly when there is no plan to run, instead of starting an empty run", async () => {
    const empty = createApp({ model: () => model, liveLedgerName: () => "live:unused", demoPlan: () => [] });
    const res = await empty.fetch(
      new Request("https://warden.test/demo/runs", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }),
      { ...env, WARDEN_TOKEN: TOKEN },
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "no_demo_plan" });
  });

  it("returns 404 for a run that doesn't exist", async () => {
    expect((await get(`/demo/runs/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("returns 404 rather than an error for a run id that isn't one", async () => {
    expect((await get("/demo/runs/not-a-run-id")).status).toBe(404);
  });
});
