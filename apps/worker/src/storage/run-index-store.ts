import { migrate } from "./migrations";
import { RUN_INDEX_MIGRATIONS } from "./migrations/run-index-0001";

// Every statement the run index runs, named for what it does, all with bindings.

/** Records a run as started. A repeat of the same id changes nothing. */
const INSERT_RUN = "INSERT OR IGNORE INTO started_runs (id, started_at) VALUES (?, ?)";
/** The run started most recently: insertion order, since two can share a timestamp. */
const SELECT_LATEST = "SELECT id FROM started_runs ORDER BY rowid DESC LIMIT 1";

/** The run index's storage: its schema and the only SQL it runs. */
export class RunIndexStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Brings the schema up to date; safe to call on every start. */
  migrate(): void {
    migrate(this.storage, RUN_INDEX_MIGRATIONS);
  }

  /** Records that a run was started. */
  record(runId: string, at: number): void {
    this.storage.sql.exec(INSERT_RUN, runId, at);
  }

  /** The id of the run started most recently, or null if none has been. */
  latest(): string | null {
    const row = this.storage.sql.exec<{ id: string }>(SELECT_LATEST).toArray()[0];
    return row?.id ?? null;
  }
}
