# Decision log

Changes to Warden's design after the [PRD](prd.md) and [technical design](technical-design.md) were written, newest first. Each change lands together with the doc edits it causes, so the documents never lag the code.

Each entry records what changed, why, what raised it, and which docs were updated.

---

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
