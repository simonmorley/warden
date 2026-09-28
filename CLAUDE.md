# CLAUDE.md

Working rules for the AI assistant (Claude Code) building Warden. This file is how the build is directed. The README says what the AI actually did, and where it had to be corrected.

Warden is phishing triage where an AI classifier has to earn, and can lose, permission to block a URL on its own.
- Design: [docs/prd.md](docs/prd.md) and [docs/technical-design.md](docs/technical-design.md).
- Changes since then: [docs/decision-log.md](docs/decision-log.md).

## Rules that don't bend

1. **Test-first.** Write a failing test, make it pass, then tidy.
   - Commit the failing test and the passing code separately, so the history shows red before green.
   - Write as many tests as the behaviour needs. The docs never prescribe a list.
2. **The model is always real.** Every verdict in the product and the demo is a live Workers AI call through AI Gateway. Fakes exist only inside unit tests.
3. **The engine has no I/O.** `packages/engine` (and later `packages/signals`) are pure functions.
   - No network, no storage, no clock (time is a parameter), no randomness.
   - Their tsconfig gives them no DOM, Node or Workers types, so I/O doesn't even compile.
   - If a test needs a mock, the design has slipped: move the I/O out.
4. **A verdict never authorises itself.** Only the engine decides whether a verdict becomes an action. Nothing the model returns, including its stated confidence, can gate one.
5. **Design changes are logged.** If the code has to depart from the PRD or the technical design:
   - add an entry to [docs/decision-log.md](docs/decision-log.md), newest first: what changed, why, what raised it, which docs changed;
   - update those docs in the same commit.
6. **The repository is public.**
   - No secrets, tokens, account IDs or personal paths.
   - Local secrets live in `.dev.vars` (gitignored); production secrets go in with `wrangler secret put`.
   - Fixtures use reserved domains only (`example.com`/`.net`/`.org`, `.test`, `.example`, `.invalid`).
   - Fixtures use fictional brands, with no working form targets, no live URLs and nothing resembling victim data. The automated safety check enforces this.

## Code quality

- Readable over clever. Names come from the domain: verdict, ledger, epoch, bar, probation.
- **Guard clauses and early returns.** No nested `if`s, and no `else`: handle the exception case first and return, so the main path stays flat. When a branch grows, extract a function.
- **No SQL outside `apps/worker/src/storage/`.**
  - Schema changes are new, append-only migrations. Never edit one that has shipped.
  - Queries are named, parameterised statements in the store, each with a comment saying what it's for.
  - The Durable Object never builds SQL.
- **Every function has a short doc comment:** what it does, and anything a caller must know. One to three lines, TSDoc style, so developer docs can be generated from them.
- Handle errors where they occur and return a useful message. Malformed input gets a 4xx, never a 500.
- Comments and commit messages explain *why*. The code already says what.
- Keep commits small, with conventional prefixes: `test:`, `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- Read AI-written code before committing it. Nothing lands unreviewed.

## Cloudflare conventions

- Config lives in `apps/worker/wrangler.jsonc`. Run `npm run types -w @warden/worker` after changing it.
- The compatibility date stays at or below what both `wrangler dev` and the test pool's bundled runtime support.
- Ledgers are SQLite-backed Durable Objects, one instance per ledger, called through RPC methods.
- Use bindings, not REST APIs. Keep no request-scoped state in module globals.
- The Worker sees every request first (`run_worker_first`) and serves the dashboard through the `ASSETS` binding. Routing and security headers are then the same in tests, `wrangler dev` and production.
- Workers AI calls go through AI Gateway.

## Layout

```text
packages/engine     permission engine: pure functions, no I/O
packages/signals    signal extraction: pure functions            (build step 4)
packages/fixtures   fixture set, variant generator, safety check  (build step 3)
apps/worker         HTTP surface, ledger Durable Objects, inference adapter, demo driver
apps/dashboard      static dashboard, served by the Worker
apps/cli            command-line client for the same HTTP API     (bonus)
docs/               PRD, technical design, decision log
```

## Commands

```sh
npm install
npm run dev         # whole system locally at http://localhost:8787
npm test            # every workspace's tests
npm run typecheck
npm run check       # typecheck, then tests
npm run deploy
```

Local runs keep each ledger's SQLite state under `.wrangler/`. Inference always calls Workers AI, even locally, so Wrangler needs credentials. Either run `npx wrangler login`, or put `CLOUDFLARE_API_TOKEN=…` in a `.env` at the repository root (gitignored).

The Worker's scripts load that file with Node's `--env-file-if-exists`, which puts it into Wrangler's process environment only. Wrangler's own `--env-file` flag would also expose the token to the Worker as a binding, and the Worker never needs an account credential. `npm run dev:host` binds every interface, for reaching a development box over Tailscale.
