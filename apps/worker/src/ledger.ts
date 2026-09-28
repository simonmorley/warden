import { applyLabel, authorise, DEFAULT_POLICY, initialPermission } from "@warden/engine";
import { DurableObject } from "cloudflare:workers";
import { runBatch, START, type DemoLedger, type DemoStep } from "./demo";
import type {
  LabelInput,
  LabelResult,
  LedgerKind,
  LedgerState,
  OpenResult,
  Scope,
  StartRunResult,
  SubmitInput,
  SubmitResult,
} from "./ledger-types";
import { modelFor } from "./model";
import { canonicalScope } from "./scope";
import { LedgerStore } from "./storage/ledger-store";
import { isMigrated, migrate } from "./storage/migrations";

export type * from "./ledger-types";

/** Pages classified at once in each batch of a demo run. */
const BATCH_SIZE = 8;
/** A moment's grace, so whoever started a run can see it before its first batch begins. */
const FIRST_BATCH_DELAY_MS = 500;

/**
 * One permission's ledger: its state, track record, blocklist and history, in the object's
 * own SQLite database.
 *
 * It holds no policy and no SQL. Every decision comes from the engine and every read or
 * write goes through the store; the ledger's job is ordering and atomicity. Each call reads,
 * decides and writes with no await in between, so no other call can interleave.
 */
export class Ledger extends DurableObject<Env> {
  private readonly store: LedgerStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new LedgerStore(ctx.storage);
    ctx.blockConcurrencyWhile(async () => this.upgrade());
  }

  /** Opens the ledger as `kind` for `scope`, creating it the first time; reopening must match. */
  open(kind: LedgerKind, scope: Scope): OpenResult {
    const existing = this.store.ledger();
    if (!existing) return this.create(kind, scope);
    if (existing.kind !== kind) return { ok: false, error: "kind_mismatch" };
    if (existing.scope !== canonicalScope(scope)) return { ok: false, error: "scope_mismatch" };
    return { ok: true, permission: this.store.permission() };
  }

  /** Records a validated verdict and routes it through the engine: an automatic block, or a person. */
  submit(input: SubmitInput): SubmitResult {
    const ledger = this.store.ledger();
    if (!ledger) return { ok: false, error: "not_open" };
    // A verdict from another model, prompt or policy belongs to a different permission.
    if (ledger.scope !== canonicalScope(input.scope)) return { ok: false, error: "scope_mismatch" };

    const permission = this.store.permission();
    const duplicate = this.store.hasDecided(input.page.identity);
    const result = authorise(
      permission,
      { verdict: input.verdict, valid: input.valid, duplicate, epochSeen: input.epochSeen },
      DEFAULT_POLICY,
    );
    const decisionId = crypto.randomUUID();
    const now = Date.now();
    const blocked = result.route.to === "block";

    // The decision, its reserved cap slot and its block commit together or not at all.
    this.store.transaction(() => {
      this.store.insertDecision({
        id: decisionId,
        page: input.page,
        epoch: permission.epoch,
        epochSeen: input.epochSeen,
        verdict: input.verdict,
        valid: input.valid,
        rejection: input.rejection,
        citedSignals: input.citedSignals,
        confidence: input.confidence,
        rawResponse: input.rawResponse,
        scope: ledger.scope,
        counted: result.counts,
        route: result.route,
        createdAt: now,
      });
      this.store.savePermission(result.permission);
      if (blocked) this.store.insertBlock(decisionId, input.page.url, permission.epoch, now);
    });

    return { ok: true, decisionId, route: result.route, counted: result.counts, epoch: permission.epoch };
  }

  /** Applies a trusted label once: an identical repeat is a no-op, a conflicting one is refused. */
  label(input: LabelInput): LabelResult {
    const ledger = this.store.ledger();
    if (!ledger) return { ok: false, error: "not_open" };
    // Ground truth stands in for an analyst in a demo run. In the live ledger nothing does.
    if (ledger.kind === "live" && input.source !== "human") return { ok: false, error: "ground_truth_refused" };

    const decision = this.store.decisionForLabel(input.decisionId);
    if (!decision) return { ok: false, error: "not_found" };

    const existing = this.store.labelOf(input.decisionId);
    if (existing !== undefined && existing !== input.label) return { ok: false, error: "label_conflict" };
    if (existing !== undefined) return { ok: true, applied: false, reversedUrl: null, events: [], permission: this.store.permission() };

    // Labels apply once, so a block that exists for this decision hasn't been reviewed yet.
    const blockedUrl = this.store.blockUrl(input.decisionId);
    const outcome = applyLabel(
      this.store.permission(),
      { counted: decision.counted, epoch: decision.epoch, blocked: blockedUrl !== undefined },
      input.label,
      DEFAULT_POLICY,
    );
    const now = Date.now();

    this.store.transaction(() => {
      this.store.insertLabel(input, now);
      this.store.savePermission(outcome.permission);
      if (outcome.reverse) this.store.reverseBlock(input.decisionId, now);
      for (const event of outcome.events) this.store.insertEvent(input.decisionId, event, now);
    });

    return {
      ok: true,
      applied: true,
      reversedUrl: outcome.reverse ? (blockedUrl ?? null) : null,
      events: outcome.events,
      permission: outcome.permission,
    };
  }

  /** Starts a demo run of `plan` on this demo ledger. Its first batch follows shortly, by alarm. */
  async startRun(plan: readonly DemoStep[]): Promise<StartRunResult> {
    const ledger = this.store.ledger();
    if (!ledger) return { ok: false, error: "not_open" };
    // Ground truth may only ever label a demo ledger.
    if (ledger.kind !== "demo") return { ok: false, error: "not_a_demo_ledger" };
    if (this.store.run()) return { ok: false, error: "already_started" };

    this.store.insertRun(JSON.stringify(plan), START, plan.length, Date.now());
    await this.ctx.storage.setAlarm(Date.now() + FIRST_BATCH_DELAY_MS);
    return { ok: true, total: plan.length };
  }

  /** Runs one batch of the demo, saves where it got to, and books the next alarm until it's done. */
  override async alarm(): Promise<void> {
    const ledger = this.store.ledger();
    const run = this.store.run();
    if (!ledger || run?.status !== "running") return;

    const scope = JSON.parse(ledger.scope) as Scope;
    const model = modelFor(this.env);
    if (!model) return this.store.failRun("no model is configured, so the run can't classify anything");
    // A run can't switch models halfway: its permission is scoped to the one it started with.
    if (model.id !== scope.modelId) {
      return this.store.failRun(`the configured model is ${model.id}, but this run is scoped to ${scope.modelId}`);
    }

    try {
      const plan = JSON.parse(run.plan) as DemoStep[];
      const progress = await runBatch(this.asDemoLedger(), model, scope, plan, run.progress, BATCH_SIZE);
      this.store.saveRunProgress(progress);
      if (!progress.done) await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      this.store.failRun(error instanceof Error ? error.message : String(error));
    }
  }

  /** Everything the dashboard shows about this ledger, or null if it was never opened. */
  state(): LedgerState | null {
    const ledger = this.store.ledger();
    if (!ledger) return null;

    const run = this.store.run();
    return {
      kind: ledger.kind,
      scope: JSON.parse(ledger.scope) as Scope,
      permission: this.store.permission(),
      blocklist: this.store.blocklist(),
      decisions: this.store.decisions(),
      events: this.store.events(),
      ...(run && { run: { status: run.status, next: run.progress.next, total: run.total, reason: run.reason } }),
    };
  }

  /** Creates the ledger: migrates its storage, then records its kind, scope and starting permission. */
  private create(kind: LedgerKind, scope: Scope): OpenResult {
    migrate(this.ctx.storage);
    const permission = initialPermission();
    this.store.transaction(() => {
      this.store.createLedger(kind, canonicalScope(scope), Date.now());
      this.store.savePermission(permission);
    });
    return { ok: true, permission };
  }

  /**
   * Brings a ledger opened by older code up to date before its first call. One that was never
   * opened is left alone: the schema is only created by open(), so probing an id writes nothing.
   */
  private upgrade(): void {
    if (!isMigrated(this.ctx.storage)) return;
    migrate(this.ctx.storage);
  }

  /** The ledger as the demo driver sees it: the same methods everything else uses. */
  private asDemoLedger(): DemoLedger {
    return {
      epoch: async () => this.store.permission().epoch,
      submit: async (input) => this.submit(input),
      label: async (input) => this.label(input),
    };
  }
}
