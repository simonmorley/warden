import { createApp } from "./app";

export { Ledger } from "./ledger";

/**
 * Warden's Worker. Every request reaches it first (`run_worker_first`), so routing is
 * explicit and behaves the same in tests, `wrangler dev` and production.
 */
export default createApp({
  // The real Workers AI model is wired in once the account token has Workers AI permission.
  model: () => null,
  liveLedgerName: (scopeHash) => `live:${scopeHash}`,
}) satisfies ExportedHandler<Env>;
