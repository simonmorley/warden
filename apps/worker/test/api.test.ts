import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Model } from "../src/inference/classify";

const TOKEN = "test-token";
const PHISH = {
  url: "https://secure-login.northwind-bank.example/verify",
  html: `<title>Northwind Bank | Sign in</title>
    <form action="https://collect.northwind-verify.invalid/s"><input type="password"></form>`,
};

/** A stand-in for Workers AI; the product itself only ever uses the real one. */
const answering = (verdict: object | string): Model => ({
  id: "@cf/test/model",
  complete: async () => (typeof verdict === "string" ? verdict : JSON.stringify(verdict)),
});
const phishing = answering({
  verdict: "phishing",
  confidence: 0.9,
  evidence: ["form_posts_offsite"],
  reasoning: "Posts a password to another site.",
});

// Each app gets its own live ledger, so tests' histories can't mix.
const appWith = (model: Model | null) => {
  const name = `live:${crypto.randomUUID()}`;
  return createApp({ model: () => model, liveLedgerName: () => name, demoPlan: () => [] });
};
// A deployed instance: a token and no local mode. Tests that want local set it themselves.
const testEnv = { ...env, WARDEN_TOKEN: TOKEN, WARDEN_OPEN: "" };

function call(app: ReturnType<typeof createApp>, method: string, path: string, init: { body?: unknown; token?: string | null } = {}, bindings = testEnv) {
  const headers = new Headers({ "content-type": "application/json" });
  const token = init.token === undefined ? TOKEN : init.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return app.fetch(new Request(`https://warden.test${path}`, { method, headers, body: body ?? null }), bindings);
}

describe("authentication", () => {
  // WARDEN_OPEN comes from .dev.vars, which only `wrangler dev` loads and no deploy ever
  // does. So a local run needs no credential and a deployed one always does, with nothing
  // for a person to paste anywhere.
  it("needs no token when running locally, so a clone works straight after npm run dev", async () => {
    const local = { ...testEnv, WARDEN_OPEN: "true" };
    const res = await call(appWith(phishing), "POST", "/classify", { body: PHISH, token: null }, local);

    expect(res.status).toBe(200);
  });

  it("still accepts a token locally, so the CLI behaves the same either way", async () => {
    const local = { ...testEnv, WARDEN_OPEN: "true" };
    const res = await call(appWith(phishing), "POST", "/classify", { body: PHISH }, local);

    expect(res.status).toBe(200);
  });

  it("refuses a deployment that has neither a token nor local mode, rather than opening up", async () => {
    const misconfigured = { ...env, WARDEN_TOKEN: "", WARDEN_OPEN: "" } as unknown as Env;
    const res = await call(appWith(phishing), "POST", "/classify", { body: PHISH, token: null }, misconfigured);

    expect(res.status).toBe(401);
  });

  it.each([
    ["POST", "/classify"],
    ["POST", "/live/labels"],
  ])("refuses %s %s without a token", async (method, path) => {
    const res = await call(appWith(phishing), method, path, { body: {}, token: null });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({ error: "unauthorised" });
  });

  it("refuses a wrong token", async () => {
    const res = await call(appWith(phishing), "POST", "/classify", { body: PHISH, token: "not-the-token" });
    expect(res.status).toBe(401);
  });

  it("lets anyone read the live ledger, which changes nothing and costs nothing", async () => {
    const res = await call(appWith(phishing), "GET", "/live", { token: null });
    expect(res.status).toBe(200);
  });
});

describe("malformed requests get a useful 4xx, never a 500", () => {
  it.each([
    ["a body that isn't JSON", "{not json"],
    ["an html field that isn't a string", { url: PHISH.url, html: 42 }],
    ["a URL that isn't http(s)", { url: "javascript:alert(1)", html: "<p>hi</p>" }],
    ["a relative URL", { url: "/login", html: "<p>hi</p>" }],
  ])("rejects %s with 400", async (_what, body) => {
    const res = await call(appWith(phishing), "POST", "/classify", { body });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request", message: expect.any(String) });
  });

  it("rejects the wrong method with 405 and says which are allowed", async () => {
    const res = await call(appWith(phishing), "GET", "/classify");

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

describe("POST /classify: from a URL alone", () => {
  const serving = (html: string) =>
    (async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

  it("fetches the page when no source is given, because a reporter has a URL and not HTML", async () => {
    const app = createApp({
      model: () => phishing,
      liveLedgerName: () => `live:${crypto.randomUUID()}`,
      demoPlan: () => [],
      fetcher: serving('<form action="https://collect.northwind.invalid/s"><input type="password"></form>'),
    });

    const res = await call(app, "POST", "/classify", { body: { url: PHISH.url } });
    const decision = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(decision).toMatchObject({ verdict: "phishing", fetched: true });
    expect(decision["signals"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "form_posts_offsite" })]));
  });

  it("explains a page it could not fetch, rather than classifying nothing", async () => {
    const app = createApp({
      model: () => phishing,
      liveLedgerName: () => `live:${crypto.randomUUID()}`,
      demoPlan: () => [],
      fetcher: (async () => {
        throw new Error("no route");
      }) as unknown as typeof fetch,
    });

    const res = await call(app, "POST", "/classify", { body: { url: PHISH.url } });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "fetch_failed", reason: "unreachable" });
  });

  it("uses the source it is given without fetching anything", async () => {
    const app = createApp({
      model: () => phishing,
      liveLedgerName: () => `live:${crypto.randomUUID()}`,
      demoPlan: () => [],
      fetcher: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });

    const res = await call(app, "POST", "/classify", { body: PHISH });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fetched: false });
  });
});

describe("POST /classify: try it live", () => {
  it("classifies a pasted snapshot and records it in the live ledger for a human", async () => {
    const app = appWith(phishing);

    const res = await call(app, "POST", "/classify", { body: PHISH });
    const decision = await res.json<Record<string, unknown>>();

    expect(res.status).toBe(200);
    expect(decision).toMatchObject({
      verdict: "phishing",
      valid: true,
      citedSignals: ["form_posts_offsite"],
      route: { to: "human", reason: "shadow" },
      counted: true,
    });
    expect(decision["signals"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "form_posts_offsite" })]));
  });

  it("records a response that fails validation as rejected, still sending it to a human", async () => {
    const res = await call(appWith(answering("The page looks like phishing.")), "POST", "/classify", { body: PHISH });

    expect(await res.json()).toMatchObject({ valid: false, rejection: "schema", route: { to: "human", reason: "rejected" } });
  });

  it("says plainly when no model is configured", async () => {
    const res = await call(appWith(null), "POST", "/classify", { body: PHISH });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "inference_unavailable" });
  });
});

describe("POST /live/labels", () => {
  async function classified() {
    const app = appWith(phishing);
    const res = await call(app, "POST", "/classify", { body: PHISH });
    const { decisionId } = await res.json<{ decisionId: string }>();
    return { app, decisionId };
  }

  it("applies a human's label once; a repeat is a no-op and a conflicting label is refused", async () => {
    const { app, decisionId } = await classified();

    const first = await call(app, "POST", "/live/labels", { body: { decisionId, label: "right" } });
    const repeat = await call(app, "POST", "/live/labels", { body: { decisionId, label: "right" } });
    const conflicting = await call(app, "POST", "/live/labels", { body: { decisionId, label: "wrong" } });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ applied: true });
    expect(await repeat.json()).toMatchObject({ applied: false });
    expect(conflicting.status).toBe(409);
  });

  it("returns 404 for a decision the ledger has never seen", async () => {
    const { app } = await classified();
    const res = await call(app, "POST", "/live/labels", { body: { decisionId: "nope", label: "right" } });
    expect(res.status).toBe(404);
  });

  it("rejects a label that is neither right nor wrong", async () => {
    const { app, decisionId } = await classified();
    const res = await call(app, "POST", "/live/labels", { body: { decisionId, label: "probably" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /live", () => {
  it("shows the live ledger's scope, state and decisions", async () => {
    const app = appWith(phishing);
    await call(app, "POST", "/classify", { body: PHISH });

    const res = await call(app, "GET", "/live", { token: null });
    const state = await res.json<Record<string, unknown>>();

    expect(state).toMatchObject({
      kind: "live",
      scope: { abuseType: "phishing", action: "block_url", modelId: "@cf/test/model" },
      permission: { state: "SHADOW", epoch: 1 },
      // The rules in force, so anyone reading this can recompute the bound for themselves.
      policy: { requiredScore: 0.95, z: 1.96, probationLength: 10, maxUnreviewed: 3 },
    });
    expect(state["decisions"]).toHaveLength(1);
  });

  it("reports the standing the engine derives, so a record that can't reach the bar says so", async () => {
    const res = await call(appWith(phishing), "GET", "/live", { token: null });

    expect(await res.json()).toMatchObject({ standing: "SHADOW" });
  });
});
