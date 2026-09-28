export { Ledger } from "./ledger";

/**
 * Warden's Worker. Every request reaches this handler first (`run_worker_first`), so
 * routing is explicit and behaves the same in tests, `wrangler dev` and production.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;

    const { pathname } = new URL(request.url);
    return Response.json(
      { error: "not_found", message: `Nothing at ${request.method} ${pathname}` },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
