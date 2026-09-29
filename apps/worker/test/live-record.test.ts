import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Model } from "../src/inference/classify";

const TOKEN = "test-token";
const PHISH = {
  url: "https://secure-login.northwind-bank.example/verify",
  html: '<title>Northwind Bank</title><form action="https://collect.northwind.invalid/s"><input type="password"></form>',
};

const model: Model = {
  id: "@cf/test/model",
  complete: async () =>
    JSON.stringify({ verdict: "phishing", confidence: 0.9, evidence: ["form_posts_offsite"], reasoning: "x" }),
};

const appWith = () => {
  const name = `live:${crypto.randomUUID()}`;
  return createApp({ model: () => model, liveLedgerName: () => name, demoPlan: () => [] });
};
const local = { ...env, WARDEN_TOKEN: TOKEN, WARDEN_OPEN: "true" };

const call = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`https://warden.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    }),
    local,
  );

// The live record is what a deployment's permission rests on, and it is meant to be permanent.
// Scoring runs get a throwaway ledger each, so nothing needs a way to wipe this one.
describe("the live record", () => {
  it("cannot be emptied over HTTP: there is no reset", async () => {
    const app = appWith();
    await call(app, "POST", "/classify", PHISH);

    const reset = await call(app, "POST", "/live/reset");

    expect(reset.status).toBe(404);
    expect((await (await call(app, "GET", "/live")).json<{ decisions: unknown[] }>()).decisions).toHaveLength(1);
  });
});
