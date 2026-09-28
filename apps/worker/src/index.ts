import { demoPlan } from "@warden/fixtures";
import { createApp } from "./app";
import { modelFor } from "./model";

export { Ledger } from "./ledger";

/**
 * Warden's Worker. Every request reaches it first (`run_worker_first`), so routing is
 * explicit and behaves the same in tests, `wrangler dev` and production.
 */
export default createApp({
  model: modelFor,
  liveLedgerName: (scopeHash) => `live:${scopeHash}`,
  demoPlan,
}) satisfies ExportedHandler<Env>;
