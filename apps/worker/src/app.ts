import { DEFAULT_POLICY, standing } from "@warden/engine";
import { ALL_FIXTURES, SEEDS } from "@warden/fixtures";
import { pageIdentity } from "@warden/signals";
import { evaluate } from "./evaluation";
import { authorised, BadRequest, json, problem, readObject, requireString, runningLocally } from "./http";
import type { DemoStep } from "./demo";
import type { Model } from "./inference/classify";
import type { Scope } from "./ledger";
import { decide, type LedgerPort } from "./pipeline";
import { fetchSnapshot } from "./snapshot";
import { currentScope, scopeHash } from "./scope";

export interface Dependencies {
  /** The model to classify with, or null when none is configured. */
  model(env: Env): Model | null;
  /** The live ledger's Durable Object name for a scope. */
  liveLedgerName(scopeHash: string): string;
  /** The pages a demo run walks through, in order. */
  demoPlan(): readonly DemoStep[];
  /** How a reported page is fetched when no source is given. Injected so tests never leave the machine. */
  fetcher?: typeof fetch;
}

interface Handler {
  /** Anything that changes state or spends inference needs the token (PRD 12). */
  readonly auth: boolean;
  run(request: Request, env: Env, dependencies: Dependencies, params: readonly string[]): Promise<Response>;
}

interface Route {
  readonly pattern: RegExp;
  readonly handlers: Partial<Record<string, Handler>>;
}

const MAX_HTML = 1_000_000;
const MAX_URL = 2_048;

const ROUTES: readonly Route[] = [
  { pattern: /^\/classify$/, handlers: { POST: { auth: true, run: classifyPage } } },
  { pattern: /^\/live$/, handlers: { GET: { auth: false, run: readLive } } },
  { pattern: /^\/live\/labels$/, handlers: { POST: { auth: true, run: labelLive } } },
  { pattern: /^\/corpus$/, handlers: { GET: { auth: false, run: readCorpus } } },
  { pattern: /^\/corpus\/pages\/([^/]+)$/, handlers: { GET: { auth: false, run: readCorpusPage } } },
  { pattern: /^\/corpus\/pages\/([^/]+)\/source$/, handlers: { GET: { auth: false, run: serveCorpusPage } } },
  { pattern: /^\/demo\/runs$/, handlers: { POST: { auth: true, run: startDemoRun } } },
  { pattern: /^\/demo\/runs\/([^/]+)$/, handlers: { GET: { auth: false, run: watchDemoRun } } },
];

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApp(dependencies: Dependencies) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      const matched = ROUTES.map((candidate) => ({ candidate, match: candidate.pattern.exec(pathname) })).find(
        ({ match }) => match !== null,
      );

      if (!matched) return serveAsset(request, env, pathname);

      const route = matched.candidate.handlers;
      const handler = route[request.method];
      if (!handler) {
        return problem(405, "method_not_allowed", `${pathname} doesn't accept ${request.method}.`, {
          allow: Object.keys(route).join(", "),
        });
      }
      const permitted = runningLocally(env) || (await authorised(request, env.WARDEN_TOKEN));
      if (handler.auth && !permitted) {
        return problem(401, "unauthorised", "This needs a valid bearer token.", { "www-authenticate": "Bearer" });
      }

      try {
        return await handler.run(request, env, dependencies, matched.match!.slice(1));
      } catch (error) {
        if (error instanceof BadRequest) return problem(400, "bad_request", error.message);
        console.error("unhandled error", { pathname, error: String(error) });
        return problem(500, "internal", "Something went wrong on our side.");
      }
    },
  };
}

async function classifyPage(request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  const model = dependencies.model(env);
  if (!model) return noModel();

  const body = await readObject(request);
  const url = requireString(body, "url", MAX_URL);
  try {
    pageIdentity(url);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : "The url must be an absolute http(s) URL.");
  }

  // A reporter has a URL, not the page's source. Given only a URL, fetch it.
  const supplied = body["html"] === undefined ? null : requireString(body, "html", MAX_HTML);
  let fetched = false;
  let page = { url, html: supplied ?? "" };
  if (supplied === null) {
    const snapshot = await fetchSnapshot(url, {
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
      selfOrigin: new URL(request.url).origin,
    });
    if (!snapshot.ok) {
      return problem(502, "fetch_failed", `Warden could not read that page: ${snapshot.reason}.`, {}, { reason: snapshot.reason });
    }
    fetched = true;
    page = { url: snapshot.finalUrl, html: snapshot.html };
  }

  const scope = await currentScope(model.id);
  const { stub, epoch } = await openLive(env, dependencies, scope);
  const port: LedgerPort = { epoch: async () => epoch, submit: (input) => stub.submit(input) };
  const { analysis, classification, submission } = await decide(port, model, scope, page);
  if (!submission.ok) throw new Error(`the live ledger refused a submission: ${submission.error}`);

  return json({
    fetched,
    decisionId: submission.decisionId,
    route: submission.route,
    counted: submission.counted,
    epoch: submission.epoch,
    verdict: classification.verdict,
    valid: classification.ok,
    rejection: classification.ok ? null : classification.rejection,
    confidence: classification.ok ? classification.confidence : null,
    citedSignals: classification.ok ? classification.citedSignals : [],
    reasoning: classification.ok ? classification.reasoning : null,
    signals: analysis.signals,
    excerpt: analysis.excerpt,
  });
}

async function readLive(_request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  const model = dependencies.model(env);
  if (!model) return noModel();
  const { stub } = await openLive(env, dependencies, await currentScope(model.id));
  const state = await stub.state();
  if (!state) throw new Error("the live ledger was opened but reports no state");
  return json({ ...state, policy: DEFAULT_POLICY, standing: standing(state.permission, DEFAULT_POLICY) });
}

async function labelLive(request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  const model = dependencies.model(env);
  if (!model) return noModel();

  const body = await readObject(request);
  const decisionId = requireString(body, "decisionId", 100);
  const label = body["label"];
  if (label !== "right" && label !== "wrong") throw new BadRequest('"label" must be "right" or "wrong".');

  const { stub } = await openLive(env, dependencies, await currentScope(model.id));
  // With a shared token there is no person to name; Access would put a name here (PRD 12).
  const result = await stub.label({ decisionId, label, source: "human", labelledBy: "token-holder" });
  if (result.ok) return json(result);
  if (result.error === "not_found") return problem(404, "not_found", "The live ledger has no such decision.");
  if (result.error === "label_conflict") {
    return problem(409, "label_conflict", "This decision already has a different label, and labels are immutable.");
  }
  throw new Error(`the live ledger refused a label: ${result.error}`);
}

/**
 * The pages a demo run walks, and how the set is built. Read-only and unauthenticated: it
 * spends nothing, and without it the decision feed is a list of near-identical URLs with
 * nothing to say what any of them is.
 */
async function readCorpus(): Promise<Response> {
  const pages = ALL_FIXTURES.map((fixture) => ({
    id: fixture.id,
    url: fixture.url,
    truth: fixture.truth,
    category: fixture.category,
    campaign: fixture.campaign,
    technique: fixture.provenance?.technique ?? fixture.category,
    // A generated sibling names the seed it came from; a seed names itself.
    seed: fixture.seed ?? fixture.id,
  }));

  return json({
    pages,
    // One entry per hand-written page, so a picker can offer one of each kind.
    techniques: SEEDS.map((seed) => ({
      id: seed.id,
      url: seed.url,
      truth: seed.truth,
      category: seed.category,
      technique: seed.provenance?.technique ?? seed.category,
    })),
    summary: {
      pages: pages.length,
      phishing: pages.filter((page) => page.truth === "phishing").length,
      legitimate: pages.filter((page) => page.truth === "legitimate").length,
      techniques: SEEDS.length,
      campaigns: new Set(pages.map((page) => page.campaign)).size,
    },
  });
}

/** One test page's source, so the dashboard can offer it without anyone writing HTML. */
async function readCorpusPage(
  _request: Request,
  _env: Env,
  _dependencies: Dependencies,
  [id]: readonly string[],
): Promise<Response> {
  const page = ALL_FIXTURES.find((fixture) => fixture.id === id);
  if (!page) return problem(404, "not_found", "There is no such test page.");
  return json({
    id: page.id,
    url: page.url,
    html: page.html,
    truth: page.truth,
    category: page.category,
    technique: page.provenance?.technique ?? page.category,
  });
}

/**
 * An example page at a real URL, so "try one" can mean a URL rather than pasted source.
 *
 * Served as plain text, never as HTML: these pages imitate phishing, and the fixture safety
 * rules say no browser should ever render one. Warden's fetcher accepts text/plain, so it
 * reads them exactly as it would any other page.
 */
async function serveCorpusPage(
  _request: Request,
  _env: Env,
  _dependencies: Dependencies,
  [id]: readonly string[],
): Promise<Response> {
  const page = ALL_FIXTURES.find((fixture) => fixture.id === id);
  if (!page) return problem(404, "not_found", "There is no such test page.");
  return new Response(page.html, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

async function startDemoRun(_request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  const model = dependencies.model(env);
  if (!model) return noModel();
  const plan = dependencies.demoPlan();
  if (plan.length === 0) return problem(503, "no_demo_plan", "There are no fixtures to run a demo with yet.");

  // Every run gets a fresh ledger of its own, so runs start clean and viewers can't collide.
  const runId = crypto.randomUUID();
  const scope = await currentScope(model.id);
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`demo:${runId}`));
  const opened = await stub.open("demo", scope);
  if (!opened.ok) throw new Error(`could not open a demo ledger: ${opened.error}`);
  const started = await stub.startRun(plan);
  if (!started.ok) throw new Error(`could not start a demo run: ${started.error}`);

  return json({ runId, total: started.total, watch: `/demo/runs/${runId}` }, 202);
}

async function watchDemoRun(
  _request: Request,
  env: Env,
  _dependencies: Dependencies,
  [runId]: readonly string[],
): Promise<Response> {
  if (!runId || !RUN_ID.test(runId)) return problem(404, "not_found", "There is no such scoring run.");
  const state = await env.LEDGER.get(env.LEDGER.idFromName(`demo:${runId}`)).state();
  if (!state || state.kind !== "demo") return problem(404, "not_found", "There is no such scoring run.");
  return json({
    ...state,
    policy: DEFAULT_POLICY,
    // The throwaway permission's standing, and what the run measured about the configuration.
    standing: standing(state.permission, DEFAULT_POLICY),
    evaluation: evaluate(state.decisions, DEFAULT_POLICY),
  });
}

async function openLive(env: Env, dependencies: Dependencies, scope: Scope) {
  const name = dependencies.liveLedgerName(await scopeHash(scope));
  const stub = env.LEDGER.get(env.LEDGER.idFromName(name));
  const opened = await stub.open("live", scope);
  if (!opened.ok) throw new Error(`could not open the live ledger: ${opened.error}`);
  return { stub, epoch: opened.permission.epoch };
}

/** Serves a dashboard file with the security headers, or a JSON 404 when there's no such file. */
async function serveAsset(request: Request, env: Env, pathname: string): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) return problem(404, "not_found", `Nothing at ${request.method} ${pathname}`);
  return withSecurityHeaders(asset);
}

/**
 * The dashboard displays attacker-written page text. It renders it as text, and this policy
 * makes sure nothing that slips through could run: same-origin scripts, styles, fonts and
 * connections only, nothing inline, no framing.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withSecurityHeaders(asset: Response): Response {
  const response = new Response(asset.body, asset);
  response.headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}

function noModel(): Response {
  return problem(503, "inference_unavailable", "No model is configured, so there is no live permission to use.");
}
