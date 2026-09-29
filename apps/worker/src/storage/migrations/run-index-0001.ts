import type { Migration } from "./index";

/** The run index: which scoring runs have been started, in order. */
export const RUN_INDEX: Migration = {
  id: "run-index-0001",
  description: "Scoring runs, in the order they were started",
  statements: [
    // One row per run. Its rowid keeps the order runs were started in, which is what "latest" means.
    `CREATE TABLE started_runs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL
    )`,
  ],
};

/** Every run-index migration, oldest first. Append; never edit one that has shipped. */
export const RUN_INDEX_MIGRATIONS: readonly Migration[] = [RUN_INDEX];
