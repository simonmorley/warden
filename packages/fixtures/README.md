# Fixtures

The pages Warden is tested and demonstrated against. Every one is written here, from scratch. None is a copy of a real phishing page, and none ever will be — see "Why these aren't real pages" below.

A fixture is a page, a hand-set label, a category and a campaign id. The label says what the page really is; whether the model agrees is measured, never assumed, so a fixture carries no expected verdict.

## What a fixture has to do

Warden's classifier is given extracted signals and a bounded excerpt of a page's text — never raw markup. So a fixture's job is to *exhibit a technique*: the fields it asks for, where it sends them, how its scripts behave, where its assets come from. A schematic page that does that produces the same signals as a faithful replica would, which is why the replica buys nothing.

The set as a whole has to cover:

- **Positives** across distinct techniques, so the classifier can't pass by recognising one.
- **Hard negatives** — legitimate pages that look like phishing. A real bank's sign-in page and a fake one share most of their structure, and that is the whole difficulty. Without these the false-positive path is never exercised, and false positives are what the design is about.
- **Ambiguous pages** that should route to a person rather than either verdict.
- **Injection pages, in both directions.** A *weaponised report* is a legitimate page whose user-generated content tells reviewers it is phishing: abuse of the abuse process, and the trap for the autonomous mistake. An *evasion* page is phishing that tells the model it is legitimate, which shows a missed phish being tracked rather than blocked.
- **Campaign siblings**: at least two positives sharing a technique while differing in domain, host and hash, because real campaigns occupy hundreds of near-identical domains. They test whether the classifier reads the technique or just the infrastructure, and their shared campaign id makes the independence limitation in PRD §6.2 visible.

## Writing one

1. Take a technique — from the survey below, or from a category the set is missing.
2. Write the smallest page that exhibits it. Structure, not persuasion: the point is the form target and the field names, not the paragraph explaining why the account is locked.
3. Set the label, the category and the campaign id yourself. You wrote it, so you know what it is.
4. Run the tests. The safety check is one of them, and it fails the build rather than warning.

## The safety rules

Enforced by `checkFixture`, which runs over every fixture in the test suite:

| Rule | Why |
| --- | --- |
| Reserved names only — `example.com`/`.net`/`.org`, `.test`, `.example`, `.invalid` | Nothing resolves to somebody's real site |
| Form and script targets on `.invalid` only | `.invalid` is the one suffix guaranteed never to resolve; `example.com` really is served |
| Fictional brands | A fixture must not impersonate a real organisation |
| No email addresses outside reserved names, and nothing that passes the card checksum | Nothing that could be mistaken for a real person's data |
| No operator credentials | Bot tokens and API keys turn up in real kits; none may survive into ours |
| Every label attributed to a person | A label nobody set is not ground truth |

## The survey behind the categories

On 2026-09-28 we took 300 URLs from the OpenPhish community feed and, for a spread across hosting types, read the page copies urlscan.io already held. No live phishing site was contacted. 17 pages were readable, and we ran Warden's own signal extraction over them.

What they imitated: 5 crypto wallets or exchanges, 4 social networks, 2 ISPs, 2 webmail services, and 4 others including a streaming service and a compromised small-business site.

How often each signal fired across those 17:

| Signal | Pages |
| --- | --- |
| `brand_claim` | 16 |
| `login_prompt` | 12 |
| `free_hosting` | 11 |
| `hotlinked_assets` | 11 |
| `brand_host_mismatch` | 9 |
| `form_without_action` | 6 |
| `password_field` | 6 |
| `script_sends_offsite` | 3 |
| `obfuscated_script`, `hidden_iframe`, `urgency_language`, `noindex`, `script_redirect`, `data_uri_images` | 2 each |
| `seed_phrase_request`, `identifier_in_url`, `form_posts_offsite`, `card_fields`, `otp_field`, `credential_keywords_in_url` | 1 each |

Three things worth keeping:

- **41 of the 300 URLs were on `pages.dev` or `workers.dev`** — Cloudflare's own free hosting — and 11 of the 17 pages read were on free hosting of some kind. Abuse of the platform you're defending is the normal case, not an edge case.
- **6 of 17 submitted their form by script with no `action`.** Anything that looks only at form targets misses them, which is why `form_without_action` exists as its own signal.
- **Asking for a wallet recovery phrase had no signal at all.** It does now (`seed_phrase_request`), and the decision log records it. It fires on 1 of the 3 wallet-onboarding pages; the other two ask on a later page, which a single snapshot never sees. That is a limit of snapshot-based triage, and the set should include a page of each kind so it stays visible.

The captured pages themselves were read for these aggregates and deleted. What survives is the table above and the categories the fixtures cover.

## Why these aren't real pages

The earlier plan was to sanitise: capture a live page, strip the exfiltration endpoints, brand assets, operator credentials and recipient identifiers, and ship what remained. It was dropped for three reasons.

**Sanitising is subtractive.** It starts from something harmful and removes what you thought of. What remains is a working phishing page minus a list of known-bad parts, and anything you didn't think of ships. Writing from a technique starts from nothing and adds only what a signal needs, so there is nothing to miss.

**The fidelity buys nothing.** The classifier reads signals and an excerpt. A schematic page and a replica produce the same signals, and the set is measuring whether the classifier reads them.

**A public repository of replica phishing pages is a liability** whatever the intent — mirrored, reused, reported, with a provenance trail pointing at live compromised sites.

**What it costs, plainly.** These pages have a technique's structure but not its craft: no persuasive copy, no visual fidelity, none of what makes a real lure work on a person. So the set exercises whether the classifier reads structure, and the demo exercises the permission mechanism. Neither measures accuracy on real traffic, as PRD §6.2 says. Anyone reading a demo run as a benchmark is reading it wrong.
