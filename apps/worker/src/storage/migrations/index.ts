import { LEDGER } from "./0001_ledger";
import { DEMO_RUNS } from "./0002_demo_runs";

/** One versioned change to a ledger's schema. Once shipped, never edited: add another. */
export interface Migration {
  readonly id: string;
  readonly description: string;
  /** Run in order, inside one transaction. Kept as separate statements, never split on ";". */
  readonly statements: readonly string[];
}

/** Every migration, oldest first. Append to the end; never reorder, rename or edit. */
export const MIGRATIONS: readonly Migration[] = [LEDGER, DEMO_RUNS];

const MIGRATIONS_TABLE = "_migrations";

/**
 * Applies every migration this object hasn't had yet, in order, and returns their ids.
 * Each runs in its own transaction and is recorded with it, so a failure leaves nothing
 * half-done and the next attempt resumes cleanly.
 */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[] = MIGRATIONS): string[] {
  const { sql } = storage;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);

  const applied = new Set(
    sql
      .exec<{ id: string }>(`SELECT id FROM ${MIGRATIONS_TABLE}`)
      .toArray()
      .map((row) => row.id),
  );
  const pending = migrations.filter((migration) => !applied.has(migration.id));

  for (const migration of pending) {
    storage.transactionSync(() => {
      for (const statement of migration.statements) sql.exec(statement);
      sql.exec(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`, migration.id, Date.now());
    });
  }
  return pending.map((migration) => migration.id);
}

/** Whether this object has ever been migrated. Reads only, so asking creates nothing. */
export function isMigrated(storage: DurableObjectStorage): boolean {
  const found = storage.sql
    .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", MIGRATIONS_TABLE)
    .toArray();
  return found.length > 0;
}
