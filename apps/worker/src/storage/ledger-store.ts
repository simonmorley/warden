import type { EngineEvent, Label, Permission, PermissionState, Route, Verdict } from "@warden/engine";
import type { RunProgress } from "../demo";
import type {
  BlockedUrl,
  DecisionSummary,
  LabelInput,
  LedgerKind,
  PageRef,
  RecordedEvent,
  RunStatus,
} from "../ledger-types";
import { isMigrated } from "./migrations";

// Every statement the ledger runs, named for what it does. All of them take bindings (?);
// none is ever assembled from values, so page-derived text can't change what they do.

/** The ledger's kind and its canonical scope. */
const SELECT_LEDGER = "SELECT kind, scope FROM ledger WHERE id = 1";
/** Records what kind of ledger this is and the scope its permission belongs to. */
const INSERT_LEDGER = "INSERT INTO ledger (id, kind, scope, created_at) VALUES (1, ?, ?, ?)";

/** Where the permission stands. */
const SELECT_PERMISSION =
  "SELECT epoch, state, right_count, wrong_count, probation, unreviewed FROM permission WHERE id = 1";
/** Replaces the one permission row with the engine's latest answer. */
const UPSERT_PERMISSION = `INSERT OR REPLACE INTO permission (id, epoch, state, right_count, wrong_count, probation, unreviewed)
  VALUES (1, ?, ?, ?, ?, ?, ?)`;

/** Whether a page has been decided in this ledger before: deduplication. */
const SELECT_PAGE_DECIDED = "SELECT 1 FROM decisions WHERE page_identity = ? LIMIT 1";
/** Records a decision with the evidence behind it and what the permission check said. */
const INSERT_DECISION = `INSERT INTO decisions (id, page_identity, url, content_hash, epoch, epoch_seen, verdict, valid,
    rejection, cited_signals, confidence, raw_response, scope, counted, route, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
/** What the engine needs to know about a decision to apply a label to it. */
const SELECT_DECISION_FOR_LABEL = "SELECT counted, epoch FROM decisions WHERE id = ?";
/** Every decision, oldest first, with its label and what became of its block. */
const SELECT_DECISIONS = `SELECT d.id, d.url, d.verdict, d.valid, d.rejection, d.cited_signals, d.confidence, d.counted,
    d.route, a.status AS block, l.label, d.created_at
  FROM decisions d
  LEFT JOIN actions a ON a.decision_id = d.id
  LEFT JOIN labels l ON l.decision_id = d.id
  ORDER BY d.seq`;

/** The label already on a decision, if any. */
const SELECT_LABEL = "SELECT label FROM labels WHERE decision_id = ?";
/** Records a decision's label. The primary key refuses a second one. */
const INSERT_LABEL =
  "INSERT INTO labels (decision_id, label, source, labelled_by, created_at) VALUES (?, ?, ?, ?, ?)";

/** The URL a decision's automatic block applies to, if it made one. */
const SELECT_BLOCK_URL = "SELECT url FROM actions WHERE decision_id = ?";
/** Records an automatic block. */
const INSERT_BLOCK =
  "INSERT INTO actions (decision_id, url, epoch, status, created_at) VALUES (?, ?, ?, 'active', ?)";
/** Undoes a block. The row stays, marked reversed, so the history does too. */
const REVERSE_BLOCK = "UPDATE actions SET status = 'reversed', reversed_at = ? WHERE decision_id = ?";
/** The blocks still standing, in the order they were made. */
const SELECT_ACTIVE_BLOCKS = `SELECT a.url, a.decision_id, a.epoch, a.created_at FROM actions a
  JOIN decisions d ON d.id = a.decision_id
  WHERE a.status = 'active'
  ORDER BY d.seq`;

/** Records a promotion, demotion, revocation or reversal against the decision that caused it. */
const INSERT_EVENT = "INSERT INTO events (decision_id, detail, created_at) VALUES (?, ?, ?)";
/** Every event, oldest first. */
const SELECT_EVENTS = "SELECT decision_id, detail, created_at FROM events ORDER BY seq";

/** A demo run's plan, progress and status. */
const SELECT_RUN = "SELECT plan, progress, status, reason, total FROM runs WHERE id = 1";
/** Records a demo run that is about to start. */
const INSERT_RUN =
  "INSERT INTO runs (id, plan, progress, status, total, created_at) VALUES (1, ?, ?, 'running', ?, ?)";
/** Saves how far a demo run has got. */
const UPDATE_RUN_PROGRESS = "UPDATE runs SET progress = ?, status = ? WHERE id = 1";
/** Stops a demo run, with the reason. */
const FAIL_RUN = "UPDATE runs SET status = 'failed', reason = ? WHERE id = 1";

/** A decision as the ledger records it. */
export interface DecisionRecord {
  readonly id: string;
  readonly page: PageRef;
  readonly epoch: number;
  readonly epochSeen: number;
  readonly verdict: Verdict;
  readonly valid: boolean;
  readonly rejection: string | null;
  readonly citedSignals: readonly string[];
  readonly confidence: number | null;
  readonly rawResponse: string;
  /** The canonical scope the verdict was produced under. */
  readonly scope: string;
  readonly counted: boolean;
  readonly route: Route;
  readonly createdAt: number;
}

/** A demo run as stored: the plan stays serialised until the run needs it. */
export interface RunRecord {
  readonly plan: string;
  readonly progress: RunProgress;
  readonly status: RunStatus["status"];
  readonly reason: string | null;
  readonly total: number;
}

/**
 * Every read and write a ledger makes, as named, parameterised statements. The only place
 * outside the migrations where the ledger's SQL lives; the Durable Object never builds any.
 */
export class LedgerStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  /** Runs `write` as one transaction: all of it commits, or none of it does. */
  transaction(write: () => void): void {
    this.storage.transactionSync(write);
  }

  /** The ledger's kind and canonical scope, or undefined if it was never opened. */
  ledger(): { kind: LedgerKind; scope: string } | undefined {
    if (!isMigrated(this.storage)) return undefined;
    const row = this.sql.exec<{ kind: string; scope: string }>(SELECT_LEDGER).toArray()[0];
    if (!row) return undefined;
    return { kind: row.kind as LedgerKind, scope: row.scope };
  }

  /** Records the ledger's kind and canonical scope. */
  createLedger(kind: LedgerKind, scope: string, at: number): void {
    this.sql.exec(INSERT_LEDGER, kind, scope, at);
  }

  /** Where the permission stands now. */
  permission(): Permission {
    const row = this.sql
      .exec<{
        epoch: number;
        state: string;
        right_count: number;
        wrong_count: number;
        probation: number;
        unreviewed: number;
      }>(SELECT_PERMISSION)
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

  /** Saves the permission the engine returned. */
  savePermission(permission: Permission): void {
    this.sql.exec(
      UPSERT_PERMISSION,
      permission.epoch,
      permission.state,
      permission.right,
      permission.wrong,
      permission.probation,
      permission.unreviewed,
    );
  }

  /** Whether this page has been decided in this ledger before. */
  hasDecided(pageIdentity: string): boolean {
    return this.sql.exec(SELECT_PAGE_DECIDED, pageIdentity).toArray().length > 0;
  }

  /** Records a decision. */
  insertDecision(decision: DecisionRecord): void {
    this.sql.exec(
      INSERT_DECISION,
      decision.id,
      decision.page.identity,
      decision.page.url,
      decision.page.contentHash,
      decision.epoch,
      decision.epochSeen,
      decision.verdict,
      decision.valid ? 1 : 0,
      decision.rejection,
      JSON.stringify(decision.citedSignals),
      decision.confidence,
      decision.rawResponse,
      decision.scope,
      decision.counted ? 1 : 0,
      JSON.stringify(decision.route),
      decision.createdAt,
    );
  }

  /** Whether a decision counted and which epoch it was made in, or undefined if there's no such decision. */
  decisionForLabel(decisionId: string): { counted: boolean; epoch: number } | undefined {
    const row = this.sql.exec<{ counted: number; epoch: number }>(SELECT_DECISION_FOR_LABEL, decisionId).toArray()[0];
    if (!row) return undefined;
    return { counted: row.counted === 1, epoch: row.epoch };
  }

  /** Every decision, oldest first, as the dashboard's feed shows them. */
  decisions(): DecisionSummary[] {
    return this.sql
      .exec<{
        id: string;
        url: string;
        verdict: string;
        valid: number;
        rejection: string | null;
        cited_signals: string;
        confidence: number | null;
        counted: number;
        route: string;
        block: string | null;
        label: string | null;
        created_at: number;
      }>(SELECT_DECISIONS)
      .toArray()
      .map((row) => ({
        id: row.id,
        url: row.url,
        verdict: row.verdict as Verdict,
        valid: row.valid === 1,
        rejection: row.rejection,
        citedSignals: JSON.parse(row.cited_signals) as string[],
        confidence: row.confidence,
        counted: row.counted === 1,
        route: JSON.parse(row.route) as Route,
        block: row.block as DecisionSummary["block"],
        label: row.label as Label | null,
        createdAt: row.created_at,
      }));
  }

  /** The label already on a decision, if it has one. */
  labelOf(decisionId: string): Label | undefined {
    const row = this.sql.exec<{ label: string }>(SELECT_LABEL, decisionId).toArray()[0];
    return row?.label as Label | undefined;
  }

  /** Records a decision's label. */
  insertLabel(input: LabelInput, at: number): void {
    this.sql.exec(INSERT_LABEL, input.decisionId, input.label, input.source, input.labelledBy, at);
  }

  /** The URL a decision's block applies to, or undefined if it made none. */
  blockUrl(decisionId: string): string | undefined {
    return this.sql.exec<{ url: string }>(SELECT_BLOCK_URL, decisionId).toArray()[0]?.url;
  }

  /** Records an automatic block. */
  insertBlock(decisionId: string, url: string, epoch: number, at: number): void {
    this.sql.exec(INSERT_BLOCK, decisionId, url, epoch, at);
  }

  /** Marks a decision's block reversed. */
  reverseBlock(decisionId: string, at: number): void {
    this.sql.exec(REVERSE_BLOCK, at, decisionId);
  }

  /** The blocks still standing, oldest first. */
  blocklist(): BlockedUrl[] {
    return this.sql
      .exec<{ url: string; decision_id: string; epoch: number; created_at: number }>(SELECT_ACTIVE_BLOCKS)
      .toArray()
      .map((row) => ({ url: row.url, decisionId: row.decision_id, epoch: row.epoch, createdAt: row.created_at }));
  }

  /** Records an event against the decision that caused it. */
  insertEvent(decisionId: string, event: EngineEvent, at: number): void {
    this.sql.exec(INSERT_EVENT, decisionId, JSON.stringify(event), at);
  }

  /** Every event, oldest first. */
  events(): RecordedEvent[] {
    return this.sql
      .exec<{ decision_id: string; detail: string; created_at: number }>(SELECT_EVENTS)
      .toArray()
      .map((row) => ({
        event: JSON.parse(row.detail) as EngineEvent,
        decisionId: row.decision_id,
        createdAt: row.created_at,
      }));
  }

  /** This ledger's demo run, or undefined if none has started. */
  run(): RunRecord | undefined {
    const row = this.sql
      .exec<{ plan: string; progress: string; status: string; reason: string | null; total: number }>(SELECT_RUN)
      .toArray()[0];
    if (!row) return undefined;
    return {
      plan: row.plan,
      progress: JSON.parse(row.progress) as RunProgress,
      status: row.status as RunStatus["status"],
      reason: row.reason,
      total: row.total,
    };
  }

  /** Records a demo run that is about to start. */
  insertRun(plan: string, start: RunProgress, total: number, at: number): void {
    this.sql.exec(INSERT_RUN, plan, JSON.stringify(start), total, at);
  }

  /** Saves how far a demo run has got. */
  saveRunProgress(progress: RunProgress): void {
    this.sql.exec(UPDATE_RUN_PROGRESS, JSON.stringify(progress), progress.done ? "done" : "running");
  }

  /** Stops a demo run, keeping the reason (bounded, since it may quote an upstream error). */
  failRun(reason: string): void {
    this.sql.exec(FAIL_RUN, reason.slice(0, 300));
  }

  private get sql(): SqlStorage {
    return this.storage.sql;
  }
}
