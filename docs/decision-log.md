# Decision log

Changes to Warden's design after the [PRD](prd.md) and [technical design](technical-design.md) were written, newest first. Each change lands together with the doc edits it causes, so the documents never lag the code.

Each entry records what changed, why, what raised it, and which docs were updated.

---

## 2026-09-28 — A signal for recovery-phrase requests, from a survey of live kits

**Changed.** Signal extraction gains `seed_phrase_request`. It fires on a grid of 12 or more word fields, or on text asking for a recovery, seed or secret phrase.

**Why.**
- We ran our own extractor over 17 live phishing pages. The URLs came from the OpenPhish community feed, and the page copies were urlscan.io's stored captures, so no live site was contacted.
- The breakdown:
  - 5 imitated crypto wallets or exchanges; 4 imitated social networks; 2 each were ISP or webmail logins.
  - 11 were on free hosting, and 6 submitted their form by script with no action.
- A recovery phrase is the most valuable thing a wallet lure can steal, since it hands over the wallet itself. No signal named it.
- It fires on 1 of the 3 wallet-onboarding captures. The other two ask for the phrase on a later page, which a single snapshot never sees. That is a limit of snapshot-based triage, not of this signal.

**Raised by.** Claude Code, from the survey.

**Docs.** None; the technical design lists signal kinds by example, not exhaustively.

## 2026-09-28 — SQL moves into a storage layer, and the schema into versioned migrations

**Changed.**
- The ledger Durable Object used to carry its schema as one CREATE TABLE string, with SQL written inline throughout its methods.
- Now the schema is a list of append-only migrations, one file each, applied in order and recorded in `_migrations`. Each migration commits atomically with its record.
- Every query is a named, parameterised statement in `LedgerStore`. The Durable Object only orchestrates: engine, store, transactions.
- A ledger opened by older code is migrated before its first call. One that was never opened is still left untouched.

**Why.**
- A schema string in a class can't evolve without breaking ledgers that already exist.
- Inline SQL mixed with orchestration is hard to review: you can't see every statement the ledger runs in one place, or check each one is parameterised.

**Raised by.** The user, reviewing the ledger code.

**Docs.** `CLAUDE.md` (code quality rules).

## 2026-09-28 — A phishing verdict must cite evidence

**Changed.** The PRD required every cited signal to exist, which an empty citation list satisfies vacuously. Now a `phishing` verdict must cite at least one extracted signal, or it is rejected like any other malformed response. `not_phishing` and `uncertain` may cite nothing.

**Why.** "Why was this blocked?" must always have an answer, and "the model said so" isn't one. A phishing verdict pointing at nothing checkable shouldn't be able to earn or exercise permission to block.

**Raised by.** Claude Code, while writing the inference adapter's tests.

**Docs.** PRD §6.1, technical design §3E.

## 2026-09-28 — PhishTank joins the candidate sources

**Changed.** PhishTank is added to the feeds used to find fixture candidates.

**Why.** It is phishing-specific. Its community "verified" flag is a vote, so it gets the same treatment as every other feed: it finds candidates, and a person sets the label. Its data is not vendored into the repository, and its terms get checked when the fixture set is built.

**Raised by.** The user.

**Docs.** Technical design §3C.

## 2026-09-28 — A command-line client joins the plan and absorbs the verifier

**Changed.** The technical design had an optional black-box verifier as its last step. It now has a CLI: a thin client for the same HTTP API, pointed at `wrangler dev` or a deployment.
- The CLI can start and watch a demo run, try a page live, read a ledger and apply a label.
- Its `verify` command is the black-box check the verifier would have been.
- It's built after the dashboard, and the README moves to last.

**Why.** Both components are an HTTP client for the same API. One of them gives a terminal user something useful and still covers the deployment check.

**Raised by.** The user asked for a CLI. Claude Code proposed merging it with the verifier.

**Docs.** Technical design §2, §3I and §4.

## 2026-09-28 — No database beyond each ledger's own SQLite

**Changed.** Nothing, on reflection. We considered adding local storage (a SQLite file or D1) for development.

**Why.** Each ledger is already a SQLite-backed Durable Object. `wrangler dev` runs it locally and persists it under `.wrangler/`, and the test pool gives every test isolated storage. A second store would add a second source of truth, which is exactly what the Durable Object exists to prevent. Fixtures are bundled files and need no storage.

**Raised by.** The user asked whether local storage was needed.

**Docs.** None.

## 2026-09-28 — One Worker, segmented into workspaces, one command to run it

**Changed.** The code is an npm workspace, segmented by responsibility:
- pure packages for the engine and signal extraction, whose tsconfig exposes no I/O types;
- the fixture set;
- one Worker that owns the HTTP surface, the ledger Durable Objects, the inference adapter and the demo driver, and serves the dashboard as static assets;
- the CLI.

`npm run dev` runs the whole system locally.

**Rejected.** A separate Worker per component, connected by service bindings.
- It would enforce no boundary that the package boundaries don't already enforce. The model's output is data, and the engine treats it as untrusted wherever it runs.
- It would also separate the demo driver from the ledger Durable Object it runs inside.
- The cost would be extra configuration, deployment steps and local orchestration.

**Raised by.** The user asked for segmented services and a single command to run them.

**Docs.** None. The technical design leaves the repository layout to implementation, and `CLAUDE.md` records it.

## 2026-09-28 — A mistake's consequence depends on whether it was acted on, not on the current state

**Changed.** PRD §7.1 said a mistake made in SHADOW or EARNING costs credit only, and one made in AUTONOMOUS revokes. It now keys on whether the verdict was acted on. A wrong automatic block is always reversed. If the block was authorised in the current epoch, it also revokes, whatever state the scope has moved to since.

**Why.** A block can be confirmed wrong after the scope has already dropped to SHADOW on the bound. Keyed on state, §7.1 said that mistake costs nothing, while §5 and §7.2 said it revokes.

**Raised by.** Claude Code's review of the revised design docs, before any code existed.

**Docs.** PRD §5 (the "two consequences" line) and §7.1.
