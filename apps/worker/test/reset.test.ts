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
const guarded = { ...env, WARDEN_TOKEN: TOKEN, WARDEN_OPEN: "" };

const call = (app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown, bindings = local) =>
  app.fetch(
    new Request(`https://warden.test${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    }),
    bindings,
  );

describe("POST /live/reset", () => {
  it("empties the record, so a demonstration can start over without a stale history", async () => {
    const app = appWith();
    await call(app, "POST", "/classify", PHISH);
    expect((await (await call(app, "GET", "/live")).json<{ decisions: unknown[] }>()).decisions).toHaveLength(1);

    const reset = await call(app, "POST", "/live/reset");

    expect(reset.status).toBe(200);
    const after = await (await call(app, "GET", "/live")).json<{ decisions: unknown[]; permission: { epoch: number } }>();
    expect(after.decisions).toHaveLength(0);
    expect(after.permission).toMatchObject({ state: "SHADOW", epoch: 1, right: 0, wrong: 0 });
  });

  it("leaves a usable record behind, not a broken one", async () => {
    const app = appWith();
    await call(app, "POST", "/classify", PHISH);
    await call(app, "POST", "/live/reset");

    const res = await call(app, "POST", "/classify", PHISH);

    expect(res.status).toBe(200);
    expect((await (await call(app, "GET", "/live")).json<{ decisions: unknown[] }>()).decisions).toHaveLength(1);
  });

  it("needs the token on a deployment, since it destroys a record", async () => {
    const res = await call(appWith(), "POST", "/live/reset", undefined, guarded);
    expect(res.status).toBe(401);
  });
});
