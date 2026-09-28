import { DEFAULT_POLICY } from "@warden/engine";
import { pageIdentity } from "@warden/signals";
import { authorised, BadRequest, json, problem, readObject, requireString } from "./http";
import type { DemoStep } from "./demo";
import type { Model } from "./inference/classify";
import type { Scope } from "./ledger";
import { decide, type LedgerPort } from "./pipeline";
import { currentScope, scopeHash } from "./scope";

export interface Dependencies {
  /** The model to classify with, or null when none is configured. */
  model(env: Env): Model | null;
  /** The live ledger's Durable Object name for a scope. */
  liveLedgerName(scopeHash: string): string;
  /** The pages a demo run walks through, in order. */
  demoPlan(): readonly DemoStep[];
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
      if (handler.auth && !(await authorised(request, env.WARDEN_TOKEN))) {
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
  const page = { url: requireString(body, "url", MAX_URL), html: requireString(body, "html", MAX_HTML) };
  try {
    pageIdentity(page.url);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : "The url must be an absolute http(s) URL.");
  }

  const scope = await currentScope(model.id);
  const { stub, epoch } = await openLive(env, dependencies, scope);
  const port: LedgerPort = { epoch: async () => epoch, submit: (input) => stub.submit(input) };
  const { analysis, classification, submission } = await decide(port, model, scope, page);
  if (!submission.ok) throw new Error(`the live ledger refused a submission: ${submission.error}`);

  return json({
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
  return json({ ...(await stub.state()), policy: DEFAULT_POLICY });
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
  if (!runId || !RUN_ID.test(runId)) return problem(404, "not_found", "There is no such demo run.");
  const state = await env.LEDGER.get(env.LEDGER.idFromName(`demo:${runId}`)).state();
  if (!state || state.kind !== "demo") return problem(404, "not_found", "There is no such demo run.");
  return json({ ...state, policy: DEFAULT_POLICY });
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
 * makes sure nothing that slips through could run: same-origin scripts, styles and
 * connections only, nothing inline, no framing.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
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
