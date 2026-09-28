import { pageIdentity } from "@warden/signals";
import { authorised, BadRequest, json, problem, readObject, requireString } from "./http";
import type { Model } from "./inference/classify";
import type { Scope } from "./ledger";
import { decide, type LedgerPort } from "./pipeline";
import { currentScope, scopeHash } from "./scope";

export interface Dependencies {
  /** The model to classify with, or null when none is configured. */
  model(env: Env): Model | null;
  /** The live ledger's Durable Object name for a scope. */
  liveLedgerName(scopeHash: string): string;
}

interface Handler {
  /** Anything that changes state or spends inference needs the token (PRD 12). */
  readonly auth: boolean;
  run(request: Request, env: Env, dependencies: Dependencies): Promise<Response>;
}

const MAX_HTML = 1_000_000;
const MAX_URL = 2_048;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/classify": { POST: { auth: true, run: classifyPage } },
  "/live": { GET: { auth: false, run: readLive } },
  "/live/labels": { POST: { auth: true, run: labelLive } },
};

export function createApp(dependencies: Dependencies) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const { pathname } = new URL(request.url);
      const route = ROUTES[pathname];

      if (!route) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
        return problem(404, "not_found", `Nothing at ${request.method} ${pathname}`);
      }

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
        return await handler.run(request, env, dependencies);
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
  return json(await stub.state());
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

async function openLive(env: Env, dependencies: Dependencies, scope: Scope) {
  const name = dependencies.liveLedgerName(await scopeHash(scope));
  const stub = env.LEDGER.get(env.LEDGER.idFromName(name));
  const opened = await stub.open("live", scope);
  if (!opened.ok) throw new Error(`could not open the live ledger: ${opened.error}`);
  return { stub, epoch: opened.permission.epoch };
}

function noModel(): Response {
  return problem(503, "inference_unavailable", "No model is configured, so there is no live permission to use.");
}
