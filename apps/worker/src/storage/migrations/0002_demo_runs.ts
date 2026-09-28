import type { Migration } from "./index";

/** Demo runs: the plan a demo ledger walks through, and how far it has got. */
export const DEMO_RUNS: Migration = {
  id: "0002_demo_runs",
  description: "The demo run a demo ledger is driving, if any",
  statements: [
    // One row at most: a demo ledger runs one plan, once. Progress is saved after every batch,
    // so a run resumes where it stopped.
    `CREATE TABLE runs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      plan TEXT NOT NULL,
      progress TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
      reason TEXT,
      total INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
};
