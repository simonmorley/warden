import type { Migration } from "./index";

/** The ledger itself: its permission, the decisions it made, their labels, blocks and events. */
export const LEDGER: Migration = {
  id: "0001_ledger",
  description: "A permission's ledger: state, track record, decisions, labels, blocks and history",
  statements: [
    // One row: what kind of ledger this is, and the scope its permission belongs to.
    `CREATE TABLE ledger (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kind TEXT NOT NULL CHECK (kind IN ('demo', 'live')),
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // One row: where the permission stands. Counts are "right" and "wrong" in the current epoch.
    `CREATE TABLE permission (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('SHADOW', 'EARNING', 'AUTONOMOUS')),
      right_count INTEGER NOT NULL,
      wrong_count INTEGER NOT NULL,
      probation INTEGER NOT NULL,
      unreviewed INTEGER NOT NULL
    )`,
    // Every verdict submitted, with the evidence behind it and what the permission check said.
    // seq keeps the order decisions were made in, which is the order everything is shown in.
    `CREATE TABLE decisions (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      page_identity TEXT NOT NULL,
      url TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      epoch_seen INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('phishing', 'not_phishing', 'uncertain')),
      valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
      rejection TEXT,
      cited_signals TEXT NOT NULL,
      confidence REAL,
      raw_response TEXT NOT NULL,
      scope TEXT NOT NULL,
      counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
      route TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // Deduplication asks "has this page been decided here before?" on every submission.
    `CREATE INDEX decisions_by_page ON decisions (page_identity)`,
    // At most one label per decision: the primary key is what makes labels immutable.
    `CREATE TABLE labels (
      decision_id TEXT PRIMARY KEY REFERENCES decisions (id),
      label TEXT NOT NULL CHECK (label IN ('right', 'wrong')),
      source TEXT NOT NULL CHECK (source IN ('human', 'ground_truth')),
      labelled_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // Automatic blocks: the simulated action. A block is reversed, never deleted, so history stays.
    `CREATE TABLE actions (
      decision_id TEXT PRIMARY KEY REFERENCES decisions (id),
      url TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
      created_at INTEGER NOT NULL,
      reversed_at INTEGER
    )`,
    // Promotions, demotions, revocations and reversals, with the numbers they were decided on.
    `CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT NOT NULL REFERENCES decisions (id),
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
};
