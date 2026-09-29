# Decision log

Changes to Warden's design after the [PRD](prd.md) and [technical design](technical-design.md) were written, newest first. Each change lands together with the doc edits it causes, so the documents never lag the code.

Each entry records what changed, why, what raised it, and which docs were updated.

---

## 2026-09-29 — The dashboard no longer offers to reset the live record

**Changed.** The "Start over" button is gone from Review. `POST /live/reset` still exists, guarded like every other state change, for an operator or the CLI; the dashboard simply doesn't put it in reach.

**Why.** The live ledger is the record that qualifies a deployment, and a button that wipes it sat one click from the button that judges it. The reason the reset was added — a clean slate between demonstrations — is now served by scoring a configuration, which gets its own throwaway ledger on every run.

**Raised by.** Simon, from a pass through the running app.

**Docs.** None: the technical design describes the endpoint, which is unchanged.

---

## 2026-09-29 — The demo is an evaluation harness

**Changed.** "Demo run" is now **Score a configuration**, and the screen leads with what the run measured rather than with the permission arc:

- **The result first.** Measured accuracy of the phishing calls on the labelled set, the interval around it, and a verdict: clears the bar, not yet, or unqualifiable. It is computed by the engine over the whole run, every epoch included.
- **By campaign is the default view.** It is the result, broken down.
- **The permission arc stays, set apart and relabelled.** It is what this accuracy would do on live traffic, rehearsed on a throwaway ledger, and says plainly that it grants nothing.
- **Two gates, stated on screen.** This screen qualifies the configuration; the live ledger qualifies the deployment.

**What didn't change.** The pipeline, the engine's rules, the ledger, and the run itself. The API and code keep the name "demo run" (`/demo/runs`): the mechanism is the same one, and renaming a working endpoint for a change of framing would be churn, not design.

**Why.** Framed as a demo, a run invited the reading that the model was learning its way into being trusted, and it buried the most useful thing it produces — a measurement of one model, prompt and policy on pages whose answers are known. That measurement is also a real step in deploying anything: a configuration that can't clear the bar on a labelled set isn't worth the live queue's time. The separation matters as much as the number. A labelled set is not the traffic a permission acts on, which is exactly why a score can't be a grant, and the live ledger still starts from zero.

**Raised by.** Simon.

**Docs.** PRD §6.2 (population), §9, §13 and §14; technical design §3F and §3H.

---

## 2026-09-29 — The upper bound, and a record that can't qualify

**Changed.** The engine computes the Wilson upper bound alongside the lower, and qualifies a track record against the bar as one of three things: **clears**, **not yet**, or **unqualifiable**. A SHADOW record whose ceiling is under the bar is reported as **UNQUALIFIABLE**.

**Why.** With only a floor, a classifier that is good but not good enough looks identical to one that needs more pages. A 90% classifier against a 95% bar would sit in SHADOW indefinitely, its floor creeping towards 90% and stopping, and nothing would say it was never going to get there. The ceiling says it: at 72 right out of 80 the best its true accuracy could plausibly be is 94.8%, and waiting won't help. The right move is to change the model or prompt, which starts a new permission anyway.

**Why derived rather than a fourth state.** It routes exactly as SHADOW does, so the state machine has nothing to do differently. It isn't absorbing: enough correct calls lift the ceiling back over the bar, so storing it would mean re-deriving it on every label anyway. And EARNING and AUTONOMOUS can never be in it, since both were reached by clearing the bar. So `standing()` reports it from the counts, the ledger's schema is untouched, and no migration was needed.

**Raised by.** Simon.

**Docs.** PRD §6.3 (new) and the appendix; technical design §3A.

---

## 2026-09-28 — Injection works in one direction only, and the demo's ending depends on it

**Found.** Running the whole set through the chosen model:

- **Every evasion page was caught.** Phishing that tells the reviewer it is legitimate was correctly called phishing, 14 out of 14. The model does not credit a page vouching for itself.
- **Every trap that worked came from a third party.** A forum post, a review, an issue tracker, a support ticket, all asserting *someone else's* page is malicious. Two of five framings fooled it; one more it called phishing while citing no evidence, so the evidence rule rejected it before it could act.

**Why it matters.** The exploitable direction produces false positives, not false negatives. That is the direction Warden bounds by design, and the direction most prompt-injection thinking neglects. It also means the demo's ending rests on roughly two framings in five landing: if the model tightens, a run finishes with nothing to revoke.

**Changed.** Two further trap framings, a profile bio and a classified listing. Not to make the arc land — the right answer to a run without a revocation is to report it, which the dashboard does — but because five framings were too few to claim anything about injection robustness. Seven is still few.

**Raised by.** Review of a completed run.

**Docs.** `packages/fixtures/README.md`.

---

## 2026-09-28 — Warden fetches a reported URL

**Changed.** `POST /classify` takes a URL on its own and fetches the page. Supplying the source still works and skips the fetch.

**Why.** The design ruled out live fetching, for reproducibility and to keep live phishing out of the build. That reasoning holds for the demo corpus, which is unchanged and still fixed. It does not hold for someone trying one page themselves: nobody triaging abuse has a page's HTML, they have a URL, and requiring source made the thing a lab instrument.

**What the guards are, since the URL comes from whoever reported it.** HTTPS only. No credentials in the URL, which would otherwise be sent to whatever it resolved to. Nothing aimed at loopback, a private range, link-local metadata, or a name that resolves inside — checked again at every redirect hop rather than only the first, since a public URL can redirect inwards. At most three hops. Non-HTML refused rather than read as markup. The body read up to a cap instead of whole. Failures named, so a caller is told what happened instead of handed an empty page.

**What it doesn't do.** A plain fetch sees the HTML as served: no scripts run, and a kit that serves benign content to datacentre addresses shows it something harmless. Browser Rendering answers both and is the obvious next step; it is not built here.

**Raised by.** Simon submitted his own URL, got a verdict about a test page whose source was still in the box, and asked whether the HTML was really needed.

**Docs.** PRD §9 (browser rendering is what remains out), §12 (what bounds the fetch) and §13; technical design §3F.

---

## 2026-09-28 — A reset, for the demonstration rather than the mechanism

**Changed.** `POST /live/reset` empties the live record. The technical design had removed reset entirely, on the grounds that a demo run is a fresh ledger and a real record is meant to be permanent.

**Why.** That reasoning is right about the mechanism and wrong about a proof of concept people click around in. A record polluted by a few experiments had no way back, and the next person to open the page inherited the last one's leftovers. Nothing in the permission design depends on a record being un-resettable — an operator who can deploy the Worker can already wipe its storage.

It is guarded like anything else that changes state, it asks before destroying anything, and the code says plainly that it exists for the demonstration and not the mechanism. Demo runs need no such thing: each run already gets its own ledger, so running again *is* the reset, and the button now says "Run it again" once one has finished.

**Raised by.** Simon: "is there a way to reset the demo?"

**Docs.** Technical design §3F.

---

## 2026-09-28 — No credential in the browser, and no deployment by default

**Changed.** Three things, from one question: how does a stranger who clones this repository actually run it?

- **The dashboard no longer asks for an access token.** It had a password field you pasted a shared secret into, which the page kept in `sessionStorage`. That is gone. Protected endpoints are open when `WARDEN_OPEN=true` is set in `.dev.vars` — a file `wrangler dev` reads and no deploy ever does, which makes it a reliable "this is my own machine" signal. A deployment has no such file, so it always requires its token, and the CLI supplies it from the environment. A deployment with neither fails closed.
- **AI Gateway is optional, not required.** A gateway belongs to one account, so ours is useless to anyone else. Set `AI_GATEWAY_ID` and calls route through yours; leave it unset and they go straight to Workers AI. The adapter already worked this way; the PRD was overstating it.
- **Nothing is deployed by default.** A public instance spends the owner's inference on whoever finds it — which is what produced the token field in the first place. `npm run dev` against your own account is the better story for a repository people clone.

**Why it matters beyond tidiness.** A shared secret typed into a web form is the weakest part of any of this: it can't be attributed to a person, can't be revoked for one person, and teaches the habit of pasting credentials into pages. The PRD already said Cloudflare Access is the right answer for a real deployment, and removing the field stops pretending a form is a substitute.

**Raised by.** Simon: "I don't want the access token in a form", and the two questions about who would use our gateway and why we would deploy at all.

**Docs.** PRD §10, §12 and §13; `CLAUDE.md`.

---

## 2026-09-28 — Review lags behind the decisions, then catches up before the traps

**Changed.** In a demo run, ground truth used to land the instant each page was decided. Now it lags five steps behind, from step 130 to step 190, and is immediate either side.

**Why.** Found by running the demo for real rather than reasoning about it. The first live run made 117 automatic blocks and never once showed more than zero unreviewed: each block was reviewed the moment it was made, so the cap of three never bound. One of the design's two damage-bounding mechanisms was invisible in the demonstration of it.

Making review lag fixed that and broke something else. With review permanently behind, the cap stayed full, so when the traps arrived they queued for a person like everything else — and the run ended in AUTONOMOUS with nothing to revoke. The lag now stops at step 190 so the backlog drains before the traps land.

A run now shows both: 28 pages queued because the cap was full, and the full arc of promotion, revocation and two reversals.

**What this says about the cap.** Under sustained load with review behind, the system spends much of its time refusing to act on its own — three blocks out, everything else to a person. That is the mechanism working as designed, and it is worth seeing rather than describing.

**Raised by.** Claude Code, from a live run.

**Docs.** None; the plan's shape is an implementation detail of the fixture set.

---

## 2026-09-28 — The model is llama-3.3-70b-instruct-fp8-fast, chosen on false positives

**Changed.** The Workers AI model is now decided: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. The PRD had left it to "whatever produces reliable structured output".

**How.** Seven candidates ran Warden's real prompt, schema and validator. The three finalists then ran the whole false-positive suite — five weaponised-report traps, three hard negatives, ten phishing controls — three times each, at temperature 0.

| | False positives | Missed phishing | Rejected | Avg |
| --- | --- | --- | --- | --- |
| **llama-3.3-70b-fp8-fast** | **6 / 54** | 1 | 5 | 2517ms |
| mistral-small-3.1-24b | 12 / 54 | 1 | 2 | 3464ms |
| llama-4-scout-17b | 13 / 54 | 2 | 0 | 2350ms |

**Why this one.** Fewest false positives, which is the harm the whole design exists to bound. It rejects more often than the others (5 of 54 answers unusable), and that is the right trade: a rejection routes to a person and earns nothing, which is the safe failure the design already handles, while a false positive takes down a legitimate page.

The deciding detail is *where* its false positives came from. All six were the two traps it fell for, three runs each. It never wrongly flagged a legitimate page on that page's own merits — only when the page carried an instruction aimed at it. Which is Warden's argument in one line: the classifier is competent until someone attacks it, and permission is what bounds the damage then.

**Raised by.** Claude Code, from the measurements above.

**Docs.** PRD "deliberately not decided" no longer applies to the model; `packages/fixtures/README.md` records the trap results.

---

## 2026-09-28 — Five trap framings, because one was not a test

**Changed.** The set carries five weaponised-report traps in different framings — a forum post, a product review, an issue tracker, a support ticket and a wiki citation — rather than the single forum post first written.

**Why.** With one trap, llama-4-scout resisted it three times out of three, and the note going to Simon said the model "saw through it" and the demo might finish with nothing to revoke. Against all five it fell for four, every time. The first result was not a property of the model; it was a property of that one framing.

The framings that work are the ones that look like a decision already taken by someone with authority — an issue labelled `confirmed-malicious`, a support ticket quoting "Security Operations". The one all three finalists handled best was the plainest: a forum post simply asserting it. That pattern is worth stating: an injection that imitates process is harder to resist than one that imitates instruction.

**Raised by.** Claude Code. The single-trap result was reported to Simon as a finding before it was tested properly, which it should not have been.

**Docs.** `packages/fixtures/README.md`.

---

## 2026-09-28 — Fixtures are written from techniques, not sanitised from captured pages

**Changed.** The technical design had each fixture built from a captured live page: take a candidate from a feed, fetch the copy a public scan already holds, then strip the harmful parts — exfiltration endpoints, brand assets, operator credentials, recipient identifiers — and keep what's left.

Fixtures are now written from scratch. A survey of live pages says which techniques are in circulation and how common each is; the fixtures are then written to exhibit those techniques, as the smallest page that carries each one's structural signals. Captured pages are read for the aggregate and not kept.

**Why.**

- **Sanitising is subtractive, and subtractive is the wrong default for a public repository.** It starts from something harmful and removes what we thought of. What's left is still a working phishing page minus a list of known-bad parts, and a miss ships. Writing from a technique starts from nothing and adds only what a signal needs, so there is nothing to miss.
- **The fixtures don't need the fidelity.** The classifier is given extracted signals and a bounded excerpt, never raw markup. A schematic page produces the same signals as a faithful copy, so the extra fidelity buys nothing the set is measuring.
- **A public repository of replica phishing pages is a liability** whatever its intent: they get reported, mirrored and reused, and the provenance trail points at live compromised sites.
- **What we actually wanted from live pages was the category list**, and a survey gives that. It produced the seed-phrase signal in the entry below, which is the one finding that changed the code.

**What it costs.** A schematic page has a technique's structure but not its craft: no persuasive copy, no visual fidelity, none of the small touches that make a real lure work on a person. The set therefore exercises whether the classifier reads structure. It does not measure accuracy against real traffic — which the PRD's limitations already said, and which stays true.

**Raised by.** The safety guardrails on Claude Code stopped the step that pulled field-by-field structure out of captured pages. That was the right call: on review, the sanitising approach was the weaker design, for the reasons above, and it took a refusal to notice. The captured pages were deleted at that point.

**Docs.** Technical design §3C, and `packages/fixtures/README.md`.

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
