import {
  applyLabel,
  authorise,
  DEFAULT_POLICY,
  initialPermission,
  type EngineEvent,
  type Label,
  type Permission,
  type PermissionState,
  type Route,
  type Verdict,
} from "@warden/engine";
import { DurableObject } from "cloudflare:workers";

/** A demo ledger takes fixture ground truth as its labels; the live ledger only takes a human's. */
export type LedgerKind = "demo" | "live";

/** What a permission belongs to (PRD 4). Change any part and it's a different permission. */
export interface Scope {
  readonly abuseType: "phishing";
  readonly action: "block_url";
  readonly modelId: string;
  readonly promptHash: string;
  readonly policyHash: string;
}

export interface PageRef {
  /** The normalised URL, which deduplication and reversal key on. */
  readonly identity: string;
  /** The exact URL a block would apply to. */
  readonly url: string;
  readonly contentHash: string;
}

/** A classified page, validated by the inference adapter, submitted for a decision. */
export interface SubmitInput {
  readonly page: PageRef;
  readonly verdict: Verdict;
  readonly valid: boolean;
  /** Why validation failed, when it did: schema, unresolved_signal, timeout, provider_error. */
  readonly rejection: string | null;
  readonly citedSignals: readonly string[];
  /** Recorded for the audit trail; it gates nothing. */
  readonly confidence: number | null;
  readonly rawResponse: string;
  readonly epochSeen: number;
  /** The versions in force when the page was classified. */
  readonly scope: Scope;
}

export interface LabelInput {
  readonly decisionId: string;
  readonly label: Label;
  readonly source: "human" | "ground_truth";
  readonly labelledBy: string;
}

export type OpenResult =
  | { readonly ok: true; readonly permission: Permission }
  | { readonly ok: false; readonly error: "kind_mismatch" | "scope_mismatch" };

export type SubmitResult =
  | {
      readonly ok: true;
      readonly decisionId: string;
      readonly route: Route;
      readonly counted: boolean;
      readonly epoch: number;
    }
  | { readonly ok: false; readonly error: "not_open" | "scope_mismatch" };

export type LabelResult =
  | {
      readonly ok: true;
      /** False when the same label was already on record, which makes a repeat a no-op. */
      readonly applied: boolean;
      readonly reversedUrl: string | null;
      readonly events: readonly EngineEvent[];
      readonly permission: Permission;
    }
  | {
      readonly ok: false;
      readonly error: "not_open" | "not_found" | "label_conflict" | "ground_truth_refused";
    };

export interface BlockedUrl {
  readonly url: string;
  readonly decisionId: string;
  readonly epoch: number;
  readonly createdAt: number;
}

export interface RecordedEvent {
  readonly event: EngineEvent;
  readonly decisionId: string;
  readonly createdAt: number;
}

export interface DecisionSummary {
  readonly id: string;
  readonly url: string;
  readonly verdict: Verdict;
  readonly counted: boolean;
  readonly route: Route;
  readonly label: Label | null;
}

export interface LedgerState {
  readonly kind: LedgerKind;
  readonly scope: Scope;
  readonly permission: Permission;
  readonly blocklist: readonly BlockedUrl[];
  readonly decisions: readonly DecisionSummary[];
  readonly events: readonly RecordedEvent[];
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    kind TEXT NOT NULL CHECK (kind IN ('demo', 'live')),
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS permission (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    epoch INTEGER NOT NULL,
    state TEXT NOT NULL,
    right_count INTEGER NOT NULL,
    wrong_count INTEGER NOT NULL,
    probation INTEGER NOT NULL,
    unreviewed INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS decisions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    page_identity TEXT NOT NULL,
    url TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    epoch_seen INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    valid INTEGER NOT NULL,
    rejection TEXT,
    cited_signals TEXT NOT NULL,
    confidence REAL,
    raw_response TEXT NOT NULL,
    scope TEXT NOT NULL,
    counted INTEGER NOT NULL,
    route TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS decisions_by_page ON decisions (page_identity);
  CREATE TABLE IF NOT EXISTS labels (
    decision_id TEXT PRIMARY KEY REFERENCES decisions (id),
    label TEXT NOT NULL CHECK (label IN ('right', 'wrong')),
    source TEXT NOT NULL CHECK (source IN ('human', 'ground_truth')),
    labelled_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actions (
    decision_id TEXT PRIMARY KEY REFERENCES decisions (id),
    url TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
    created_at INTEGER NOT NULL,
    reversed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL REFERENCES decisions (id),
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

type LedgerRow = { kind: string; scope: string };
type PermissionRow = {
  epoch: number;
  state: string;
  right_count: number;
  wrong_count: number;
  probation: number;
  unreviewed: number;
};

/**
 * One permission's ledger: its state, track record, blocklist and history, in the
 * object's own SQLite database.
 *
 * It holds no policy. Every decision comes from the engine; the ledger's job is to
 * persist what the engine returns, in order, atomically.
 */
export class Ledger extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Runs before any call is delivered, so nothing ever sees a half-made schema.
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SCHEMA.split(";")) {
        if (statement.trim()) this.sql.exec(statement);
      }
    });
  }

  open(kind: LedgerKind, scope: Scope): OpenResult {
    const ledger = this.ledgerRow();
    if (!ledger) {
      const permission = initialPermission();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO ledger (id, kind, scope, created_at) VALUES (1, ?, ?, ?)",
          kind,
          canonicalScope(scope),
          Date.now(),
        );
        this.writePermission(permission);
      });
      return { ok: true, permission };
    }
    if (ledger.kind !== kind) return { ok: false, error: "kind_mismatch" };
    if (ledger.scope !== canonicalScope(scope)) return { ok: false, error: "scope_mismatch" };
    return { ok: true, permission: this.readPermission() };
  }

  submit(input: SubmitInput): SubmitResult {
    const ledger = this.ledgerRow();
    if (!ledger) return { ok: false, error: "not_open" };
    // A verdict from another model, prompt or policy belongs to a different permission.
    if (ledger.scope !== canonicalScope(input.scope)) return { ok: false, error: "scope_mismatch" };

    const permission = this.readPermission();
    const duplicate =
      this.sql.exec("SELECT 1 FROM decisions WHERE page_identity = ? LIMIT 1", input.page.identity).toArray()
        .length > 0;
    const result = authorise(
      permission,
      { verdict: input.verdict, valid: input.valid, duplicate, epochSeen: input.epochSeen },
      DEFAULT_POLICY,
    );

    const decisionId = crypto.randomUUID();
    const now = Date.now();
    // The decision, its reserved cap slot and its block commit together or not at all.
    // There is no await between reading the permission and writing it back, so no other
    // call can interleave and take the same slot.
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO decisions (id, page_identity, url, content_hash, epoch, epoch_seen, verdict, valid,
           rejection, cited_signals, confidence, raw_response, scope, counted, route, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        decisionId,
        input.page.identity,
        input.page.url,
        input.page.contentHash,
        permission.epoch,
        input.epochSeen,
        input.verdict,
        input.valid ? 1 : 0,
        input.rejection,
        JSON.stringify(input.citedSignals),
        input.confidence,
        input.rawResponse,
        canonicalScope(input.scope),
        result.counts ? 1 : 0,
        JSON.stringify(result.route),
        now,
      );
      this.writePermission(result.permission);
      if (result.route.to === "block") {
        this.sql.exec(
          "INSERT INTO actions (decision_id, url, epoch, status, created_at) VALUES (?, ?, ?, 'active', ?)",
          decisionId,
          input.page.url,
          permission.epoch,
          now,
        );
      }
    });

    return { ok: true, decisionId, route: result.route, counted: result.counts, epoch: permission.epoch };
  }

  label(input: LabelInput): LabelResult {
    const ledger = this.ledgerRow();
    if (!ledger) return { ok: false, error: "not_open" };
    // Ground truth stands in for an analyst in a demo run. In the live ledger nothing does.
    if (ledger.kind === "live" && input.source !== "human") return { ok: false, error: "ground_truth_refused" };

    const decision = this.sql
      .exec<{ counted: number; epoch: number }>("SELECT counted, epoch FROM decisions WHERE id = ?", input.decisionId)
      .toArray()[0];
    if (!decision) return { ok: false, error: "not_found" };

    const existing = this.sql
      .exec<{ label: string }>("SELECT label FROM labels WHERE decision_id = ?", input.decisionId)
      .toArray()[0];
    if (existing) {
      if (existing.label !== input.label) return { ok: false, error: "label_conflict" };
      return { ok: true, applied: false, reversedUrl: null, events: [], permission: this.readPermission() };
    }

    // Labels apply once, so a block that exists for this decision hasn't been reviewed yet.
    const block = this.sql
      .exec<{ url: string }>("SELECT url FROM actions WHERE decision_id = ?", input.decisionId)
      .toArray()[0];
    const outcome = applyLabel(
      this.readPermission(),
      { counted: decision.counted === 1, epoch: decision.epoch, blocked: block !== undefined },
      input.label,
      DEFAULT_POLICY,
    );

    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO labels (decision_id, label, source, labelled_by, created_at) VALUES (?, ?, ?, ?, ?)",
        input.decisionId,
        input.label,
        input.source,
        input.labelledBy,
        now,
      );
      this.writePermission(outcome.permission);
      if (outcome.reverse) {
        this.sql.exec(
          "UPDATE actions SET status = 'reversed', reversed_at = ? WHERE decision_id = ?",
          now,
          input.decisionId,
        );
      }
      for (const event of outcome.events) {
        this.sql.exec(
          "INSERT INTO events (decision_id, detail, created_at) VALUES (?, ?, ?)",
          input.decisionId,
          JSON.stringify(event),
          now,
        );
      }
    });

    return {
      ok: true,
      applied: true,
      reversedUrl: outcome.reverse && block ? block.url : null,
      events: outcome.events,
      permission: outcome.permission,
    };
  }

  state(): LedgerState | null {
    const ledger = this.ledgerRow();
    if (!ledger) return null;

    const blocklist = this.sql
      .exec<{ url: string; decision_id: string; epoch: number; created_at: number }>(
        `SELECT a.url, a.decision_id, a.epoch, a.created_at FROM actions a
         JOIN decisions d ON d.id = a.decision_id
         WHERE a.status = 'active' ORDER BY d.seq`,
      )
      .toArray()
      .map((row) => ({ url: row.url, decisionId: row.decision_id, epoch: row.epoch, createdAt: row.created_at }));

    const decisions = this.sql
      .exec<{ id: string; url: string; verdict: string; counted: number; route: string; label: string | null }>(
        `SELECT d.id, d.url, d.verdict, d.counted, d.route, l.label FROM decisions d
         LEFT JOIN labels l ON l.decision_id = d.id ORDER BY d.seq`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        url: row.url,
        verdict: row.verdict as Verdict,
        counted: row.counted === 1,
        route: JSON.parse(row.route) as Route,
        label: row.label as Label | null,
      }));

    const events = this.sql
      .exec<{ decision_id: string; detail: string; created_at: number }>(
        "SELECT decision_id, detail, created_at FROM events ORDER BY seq",
      )
      .toArray()
      .map((row) => ({
        event: JSON.parse(row.detail) as EngineEvent,
        decisionId: row.decision_id,
        createdAt: row.created_at,
      }));

    return {
      kind: ledger.kind as LedgerKind,
      scope: JSON.parse(ledger.scope) as Scope,
      permission: this.readPermission(),
      blocklist,
      decisions,
      events,
    };
  }

  private ledgerRow(): LedgerRow | undefined {
    return this.sql.exec<LedgerRow>("SELECT kind, scope FROM ledger WHERE id = 1").toArray()[0];
  }

  private readPermission(): Permission {
    const row = this.sql
      .exec<PermissionRow>(
        "SELECT epoch, state, right_count, wrong_count, probation, unreviewed FROM permission WHERE id = 1",
      )
      .one();
    return {
      epoch: row.epoch,
      state: row.state as PermissionState,
      right: row.right_count,
      wrong: row.wrong_count,
      probation: row.probation,
      unreviewed: row.unreviewed,
    };
  }

  private writePermission(permission: Permission): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO permission (id, epoch, state, right_count, wrong_count, probation, unreviewed)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
      permission.epoch,
      permission.state,
      permission.right,
      permission.wrong,
      permission.probation,
      permission.unreviewed,
    );
  }
}

/** The same scope always serialises to the same string, whatever order its keys arrived in. */
export function canonicalScope(scope: Scope): string {
  const { abuseType, action, modelId, promptHash, policyHash } = scope;
  return JSON.stringify({ abuseType, action, modelId, promptHash, policyHash });
}
