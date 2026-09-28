import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Model } from "../src/inference/classify";

const model: Model = { id: "@cf/test/model", complete: async () => "{}" };
const app = createApp({ model: () => model, liveLedgerName: () => "live:corpus", demoPlan: () => [] });
const get = (path: string) => app.fetch(new Request(`https://warden.test${path}`), env);

describe("GET /corpus", () => {
  it("is readable without a token: it explains the demo, and spends nothing", async () => {
    expect((await get("/corpus")).status).toBe(200);
  });

  it("describes every page the demo can use, so the dashboard can say what each one is", async () => {
    const body = await (await get("/corpus")).json<{ pages: unknown[]; techniques: unknown[] }>();

    expect(body.pages.length).toBeGreaterThan(200);
    expect(body.pages[0]).toEqual({
      id: expect.any(String),
      url: expect.any(String),
      truth: expect.stringMatching(/^(phishing|legitimate)$/),
      category: expect.any(String),
      campaign: expect.any(String),
      technique: expect.any(String),
      seed: expect.any(String),
    });
  });

  it("names each technique once, so a picker can offer one page per kind", async () => {
    const { techniques } = await (await get("/corpus")).json<{ techniques: { id: string; technique: string }[] }>();

    expect(techniques.length).toBeGreaterThanOrEqual(20);
    expect(new Set(techniques.map((t) => t.id)).size).toBe(techniques.length);
    for (const technique of techniques) expect(technique.technique).toBeTruthy();
  });

  it("says how the corpus is built, because 232 near-identical URLs need explaining", async () => {
    const body = await (await get("/corpus")).json<{ summary: Record<string, number> }>();

    expect(body.summary).toEqual({
      pages: expect.any(Number),
      phishing: expect.any(Number),
      legitimate: expect.any(Number),
      techniques: expect.any(Number),
      campaigns: expect.any(Number),
    });
  });
});
