# Warden — Technical Design

*Companion to the PRD. Components, boundaries and build order. JSON schemas and storage layout are deliberately absent — those are implementation decisions.*

---

## 1. How this is built

Everything is built test-first: a failing test, then the code that passes it, then a tidy-up. As many tests as the behaviour needs, no prescribed list. This document describes what each component is responsible for and what it guarantees; the tests follow from that during the work.

What makes it workable is that the logic worth testing has no I/O. Permission state transitions, the Wilson bound, eligibility rules and epoch handling take facts in and return a decision — no network, no clock, no storage. Everything that touches the outside world is a thin shell with almost no branching.

That split is the main design decision here. Get it wrong and the interesting behaviour becomes reachable only through mocks.

## 2. Language

TypeScript throughout. It is the first-class path on Workers — JavaScript works too, and Rust and Python are supported through their own toolchains, but TypeScript is what the platform's types, tooling and examples are built around, and there is no reason to fight that.

The permission engine is TypeScript as well. Compiling it from another language to WASM was considered and rejected: it puts an extra toolchain and a serialisation boundary on the hottest path, and buys test ergonomics that Vitest already provides.

| Component | Language |
| --- | --- |
| Engine, Durable Object, Worker handlers, signal extraction, inference adapter | TypeScript |
| Fixture set and its tooling | TypeScript — fixtures are pages plus labels, so they share the snapshot and label types |
| Dashboard | HTML and minimal JS |
| CLI *(bonus)* | TypeScript. A thin HTTP client; its `verify` command is the black-box check against a deployment |

JSON shapes live in one shared types module, imported by the Worker, the fixtures and the dashboard.

## 3. Components

### A. Permission engine

The whole of the PRD's sections 5, 6 and 7, as pure functions over values. Time is a parameter, never a call.

**Responsibilities.** The Wilson lower and upper bounds, and qualifying a record against the bar as clears, not yet or unqualifiable. The reported standing, which is SHADOW shown as UNQUALIFIABLE when the ceiling is under the bar. Which verdicts count and which are excluded. The state machine, including probation restarts, the drop from AUTONOMOUS when late labels pull the bound under the bar, and epoch changes. The unreviewed-action cap.

**Guarantees.** It returns decisions and the events they imply — never effects. "Revoke, and reverse action X" is a value it hands back; something else performs it. Given the same inputs it returns the same output, every time, with no hidden state.

### B. Permission store — Durable Object

One instance per ledger. Demo runs are keyed by run id; the live ledger is its own instance and accepts only human labels.

**Responsibilities.** Persistence, ordering and the blocklist. It calls the engine and applies what comes back. Authorising a decision and creating the block happen in the same call, next to the data — there is no separate executor and no authorisation handed out to be redeemed later.

**Guarantees.** A decision and its authorisation commit together or not at all. The cap holds under concurrent requests. Labels are immutable: an identical repeat is a no-op, a conflicting one is rejected. A request carrying a stale epoch cannot produce an automatic block. Ground-truth labels are refused outright by the live ledger.

**Boundary.** No policy logic. An `if` about precision or thresholds belongs in the engine.

### C. Fixture set

The pages everything else runs against. A designed artefact, not a folder of examples.

**Size.** Around 150 distinct phishing pages — the arc needs roughly 120 counted verdicts, and the rest is headroom for unexpected mistakes, `uncertain` answers and rejections. Plus hard negatives, benign pages, ambiguous pages and injection pages.

**Each page carries** a hand-set ground-truth label, a category and a campaign id. It does not carry an expected model verdict; what the model says is measured, not assumed.

**What the set must cover:**

- Positives across distinct techniques: credential harvest, obfuscated variants, redirect chains, multi-step card capture.
- **Hard negatives** — legitimate pages that look like phishing, including ones the chosen model has been tested to get wrong. Without these the false-positive path is never exercised, and false positives are what the design is about.
- Ambiguous pages that should route to a human rather than either verdict.
- **Injection pages in both directions.** A *weaponised report* is a legitimate page whose user-generated content tells reviewers it is phishing; it is the trap for the autonomous mistake, and it is a real Trust & Safety problem — abuse of the abuse process. An *evasion* page is phishing that tells the model it is legitimate; it shows a missed phish being tracked rather than blocked.
- Duplicate submissions, to exercise deduplication.

Rejection paths — malformed responses, citations of signals that don't exist, timeouts — are not fixtures. No page can make a real model return malformed JSON on demand. They belong in the adapter's own tests, driven by crafted responses and by real failures captured from Workers AI.

**Safety check, run automatically.** Reserved domains only (`example.com`/`.net`/`.org`, `.test`, `.example`, `.invalid`). Fictional brands. No working form targets. No live URLs anywhere, provenance included. Nothing resembling victim data. Page content is never served as HTML.

#### Where fixtures come from

**They are written, not copied.** Every fixture is a schematic page: the smallest markup that carries one technique's structural signals, with fictional brands, reserved domains and no persuasive copy. None is a replica of a real phishing page.

**Feeds and public scans inform the set; they never supply it.** Survey phishing-focused sources — OpenPhish, PhishTank, Phishing Army, public scans on urlscan.io — to learn which techniques are in circulation and how common each is. Read the aggregate, then close it and write the fixtures from the technique. Don't use URLhaus or ThreatFox here; they track malware distribution and malware IOCs, not phishing pages.

What a survey is allowed to produce is a count per category, a list of techniques worth covering, and hashes. Not page content, not lure wording, not a field-by-field transcription. A captured page is read to answer "does this category exist, and how often", and is not kept.

**Feeds never label, and neither does a survey.** A fixture's label is set by whoever wrote it, who knows what they built. Generated variants inherit their seed's label.

**Per seed:**

1. Take a technique from the survey: what the page asks for, where it sends it, how it is hosted.
2. Write the smallest page that exhibits it — the fields, the form target, the script behaviour, the asset hosts.
3. Check it against the safety rules below, which are enforced by an automated test.

**Provenance per seed** is the survey it came from and the technique it represents, not a document of origin: there is no original. A fixture is our own file, and it does not decay when some live page goes away.

**Scale.** Hand-write 10 to 20 seeds covering distinct techniques, then generate the variants from them. Variants use fictional brands, reserved domains, and varied hosts, paths and obfuscation, and inherit their seed's label and campaign id.

**Campaign siblings.** At least two positives share a technique while differing in domain, host and hash, because real campaigns occupy hundreds of near-identical domains. Siblings test whether the classifier recognises the technique or just the infrastructure. The campaign id also makes the independence limitation visible: deduplication counts siblings separately, so the dashboard can show how much of a track record came from a single campaign.

**Hard negatives and benign pages** are written the same way, from legitimate page patterns: a real bank's sign-in page and a fake one share most of their structure, which is the whole difficulty.

**What this costs.** A schematic page carries a technique's structure, not its craft. The set measures whether the classifier reads structure, and the demo measures the permission mechanism; neither measures accuracy against real traffic, and the PRD's limitations say so. See `packages/fixtures/README.md`.

**Don't vendor any blocklist or feed into the repository.** Phishing Army is CC BY-NC; the others have their own terms.

### D. Signal extraction

A pure function from page snapshot to a list of signals, each with an id.

**Responsibilities.** Pull out what a classifier can reason over: form targets and field types, script obfuscation patterns, redirect construction, brand markers, link and asset hosts, encoded blobs.

**Guarantees.** No I/O, no network, deterministic. Signal ids are stable for the same content, because evidence references cite them and validation depends on resolving them.

### E. Inference adapter

Signals and a bounded excerpt in, structured verdict out. The only component that talks to Workers AI, and every call goes through AI Gateway.

**Input.** The extracted signals *and* a bounded excerpt of the page's own text, clearly delimited as untrusted data. Both are needed: the signals are what the verdict cites, and the text is where a weaponised report or an evasion attempt lives. A model that sees only signals never encounters the injection, and the trap in PRD section 13 cannot happen.

**Responsibilities.** Build the request, call the model, validate the response, resolve cited signal ids. Temperature 0, structured output (JSON mode) from a model that supports it, and server-side validation regardless — the mode is a convenience, not a guarantee.

**Guarantees.** Page-derived content is delimited and never concatenated into instructions. A response that fails the schema, cites a signal id that doesn't exist, calls a page phishing without citing any signal, times out or errors is rejected and routed to a human, earning nothing either way. `uncertain` is a valid verdict and also routes to a human. The raw response is recorded whatever happens.

**Boundary.** It decides nothing about permission. A rejection here is an input to the engine, not a judgment on the AI.

**In the product, the model is always real.** Fakes exist only inside unit tests, and the best of those are real responses captured from Workers AI and replayed as inputs.

### F. HTTP surface

Thin. One shared types module defines every request and response shape.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/demo/runs` | token | Start a demo run. Creates a fresh ledger, returns its run id |
| `GET` | `/demo/runs/:id` | — | That run's evaluation of its configuration, and its rehearsal ledger's state, standing, decision feed and events |
| `POST` | `/classify` | token | Try it live: classify one fixture or pasted snapshot against the live ledger |
| `GET` | `/live` | — | Live ledger state, decision feed, events, and every judgement in the order it was given |
| `POST` | `/live/labels` | token | Apply a human label to a live decision |
| `GET` | `/` | — | Dashboard |

**Guarantees.** Every endpoint that changes state or spends inference requires the token, compared in constant time. Malformed bodies return a useful error rather than a 500. A demo run needs no reset, since each run is a new ledger; the live record has one, for the demonstration rather than the mechanism.

### G. Demo driver

Walks the fixture set through the real pipeline against a fresh ledger, and applies each page's ground truth as its label.

**Where it runs.** Not in the request that starts it. A run takes minutes, which outlives both the request and `waitUntil`, so `POST /demo/runs` creates the ledger, schedules the work and returns the run id immediately.

The run's own ledger Durable Object drives itself on alarms, processing a batch per alarm and keeping progress in its storage for `GET /demo/runs/:id` to read. The DO already exists per run and already owns the state, so nothing new has to coordinate. A Workflow instance per run is the alternative if batching on alarms proves awkward.

**Responsibilities.** Order, pacing and progress. Inference may run concurrently ahead of the ledger; submissions to the ledger stay in fixture order, which keeps a run to a few minutes.

**Guarantees.** It never writes to the live ledger. It asserts nothing about what the model will say — the arc in PRD section 13 is what the fixture set is curated to produce, and the dashboard reports what actually happened.

### H. Dashboard

The thing users actually work from. Permission state, versions, epoch, score against the bar, unreviewed actions against the cap, the decision feed with cited evidence and validation results, and the promotion, revocation and reversal events. A screen for scoring a configuration, which leads with the evaluation — measured accuracy, its interval, and clears, not yet or unqualifiable — breaks it down by campaign, and only then shows the permission rehearsal, marked as one. A button for trying one page live.

### I. CLI — bonus

A command-line client for the same HTTP API, pointed at `wrangler dev` or a deployment. It can start and watch a demo run, try a page live, read a ledger and apply a label.

**Guarantees.** It speaks only HTTP and holds no logic of its own. Anything it shows, the dashboard can show too. Its `verify` command is the black-box check against a deployed URL: auth is enforced, a demo run completes, and the live ledger stays untouched by it.

It is built only if time remains after the dashboard. It exists for people who work in a terminal, and for re-checking a deployment quickly.

## 4. Build order

Each step is red before it's green.

1. **Engine.** The bound, the state machine, eligibility, epochs, the cap.
2. **Durable Object store.** Ledgers, persistence, the blocklist, concurrency.
3. **Fixture set and safety check.** Before anything consumes it.
4. **Signal extraction.**
5. **Inference adapter, against real Workers AI as soon as it exists.** Capture real responses on the way past and keep them as unit-test inputs.
6. **Pipeline.** Snapshot in, decision out, evidence recorded.
7. **Deploy.**
8. **Demo driver.**
9. **Dashboard.**
10. **CLI, if there's time.**
11. **README.**

The dashboard comes before the CLI because it is what users work from. The README comes last so that it describes what was actually built.

Steps 1 and 2 are where the design is actually decided. If they take longer than expected, that's the build working.

## 5. Seams that matter

**Time.** Never read a clock inside the engine. Pass an instant in. Otherwise the epoch and cap tests need sleeps, and sleeps make a suite that lies.

**The model.** The adapter sits behind an interface, but the product only ever uses the real implementation. Fakes live in unit tests, and the most useful ones are real Workers AI responses captured during development and replayed as fixtures for the adapter's own tests.

**Versions come from content.** The prompt version is a hash of the prompt, the policy version a hash of the rules, the model version the exact Workers AI model id. Hand-bumped numbers bring back exactly the failure versioned scope exists to prevent: someone edits a prompt, forgets to bump, and the new prompt inherits the old one's track record.

**Page identity.** The normalised URL — lowercase scheme and host, default port and fragment removed. Deduplication and reversal both key on it. Compute it once, outside the engine; the engine receives an identity, it doesn't derive one.

**Engine output.** The engine returns a decision plus the events it implies, and the store writes them. Keeping that one-directional is what makes the concurrency reasoning tractable.

## 6. Risks

| Risk | Signal | Response |
| --- | --- | --- |
| The arc deviates | A demo run doesn't reach AUTONOMOUS, or reaches it without a revocation | Curate the fixture set against the chosen model, with hard negatives it's been tested to get wrong. The dashboard reports what happened; the document never claims the arc is guaranteed |
| The model resists the trap | Injection pages don't fool it | More than one trap in the set. If it resists them all, that is a result worth showing, not a bug to hide |
| Workers AI rate limits or cost | Runs fail partway, or spend more than expected | Every call through AI Gateway, with rate limiting and logging. Token required on anything that spends inference. Concurrency bounded |
| Concurrency is hard to force in the DO runtime | Can't reliably interleave requests | Prove the cap logic exhaustively in the engine; assert the store's transaction boundary rather than the race |
| The engine grows I/O | A test needs a mock | Stop and move the I/O out. This is the invariant the design rests on |

## 7. Definition of done

- All tests pass, and the behaviour was driven test-first.
- A full demo run completes on the deployed Worker, with live inference throughout.
- The fixture safety check passes.
- The README covers what it does, how to run it, which AI tools were used and how, and the architectural decisions.
