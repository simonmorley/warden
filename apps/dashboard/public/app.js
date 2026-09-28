// Warden's dashboard.
//
// Much of what it shows was written by whoever controls a reported page, so it is only ever
// inserted as text, never as markup, and no link is ever built from a page's URL.

const $ = (id) => document.getElementById(id);

/** Builds an element. Strings become text nodes, never markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) setProp(node, key, value);
  for (const child of children.flat()) appendChild(node, child);
  return node;
}

/** Sets one property: a class, an event handler, or a plain attribute. */
function setProp(node, key, value) {
  if (value === undefined || value === null || value === false) return;
  if (key === "class") {
    node.className = value;
    return;
  }
  if (key.startsWith("on")) {
    node.addEventListener(key.slice(2), value);
    return;
  }
  node.setAttribute(key, value === true ? "" : String(value));
}

/** Appends a node, or a string as a text node; skips nothing-values. */
function appendChild(node, child) {
  if (child === null || child === undefined || child === false) return;
  node.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

// Which run this tab is watching. No credential is ever held here: a local run needs none,
// and a deployed one is driven by the CLI, which reads its token from the environment.
const RUN_KEY = "warden-demo-run";

/** Reads a per-tab value, or "" when there is none or storage is blocked. */
function stored(key) {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Saves a per-tab value; an empty value removes it. Storage is a convenience, so failures are ignored. */
function store(key, value) {
  try {
    if (!value) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, value);
  } catch {
    // Without storage the value just isn't remembered.
  }
}

/** Calls the API same-origin. Never throws: failures come back as { ok: false }. */
async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: "network", message: `Couldn't reach the server: ${error}` } };
  }
}

/** A sentence for a failed call. */
function explain(res) {
  if (res.status === 401) {
    return "This instance is deployed and guarded, so the dashboard can't drive it. Use the CLI, which reads its token from the environment.";
  }
  return res.data?.message ?? `The server answered ${res.status}.`;
}

/**
 * Shows a message across the top of the page; an empty message hides it. Notes and failures
 * look different: styling an explanation like an error makes people think something broke.
 */
function showBanner(text, kind = "error") {
  const banner = $("banner");
  banner.textContent = text;
  banner.className = `banner ${kind}`;
  banner.hidden = !text;
}

// Every classification is a real model call that costs real money. Measured on this account:
// 31,216 neurons over 1,153 calls with the configured model. Shown so the bill is never a
// surprise, and flagged as the estimate it is.
const NEURONS_PER_CALL = 27;
const USD_PER_1K_NEURONS = 0.011;

/** What a number of live model calls costs, roughly. */
function costOf(calls) {
  const neurons = calls * NEURONS_PER_CALL;
  return `${calls} live model call${calls === 1 ? "" : "s"} · roughly ${neurons.toLocaleString()} neurons, about $${(
    (neurons / 1000) *
    USD_PER_1K_NEURONS
  ).toFixed(2)}`;
}

// The corpus: what each test page actually is. Without it the decision feed is a list of
// near-identical generated URLs with nothing to say what any of them is.
const corpus = { byUrl: new Map(), summary: null, techniques: [] };

/** Loads what the test pages are, and fills the picker. */
async function loadCorpus() {
  const res = await api("GET", "/corpus");
  if (!res.ok) return;
  corpus.summary = res.data.summary;
  corpus.techniques = res.data.techniques;
  for (const page of res.data.pages) corpus.byUrl.set(page.url, page);
  fillPicker();
}

// The bound is recomputed here, in the browser, from the ledger's own counts and the
// server's own policy: the arithmetic that grants permission is something anyone can check.

/** The Wilson lower bound of `right` out of `n`, or null with no evidence. */
function wilson(right, n, z) {
  if (n === 0) return null;
  const p = right / n;
  const z2 = z * z;
  const lower = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return Math.min(1, Math.max(0, lower));
}

/** How many more correct calls it takes before the proven accuracy reaches the bar. */
function correctCallsStillNeeded(right, wrong, policy) {
  for (let more = 0; more <= 10_000; more++) {
    const bound = wilson(right + more, right + wrong + more, policy.z);
    if (bound !== null && bound >= policy.requiredScore) return more;
  }
  return null;
}

/** A proportion as a percentage, or a dash for nothing. */
function pct(value) {
  if (value === null || value === undefined) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** What each permission state means, without the vocabulary. */
const STATES = {
  SHADOW: { label: "Recommends only", detail: "Everything goes to a person. Nothing is blocked automatically." },
  EARNING: { label: "On trial", detail: "The evidence is strong enough, but it must hold before it may act." },
  AUTONOMOUS: { label: "Acts alone", detail: "It may block a URL by itself, within the limits shown." },
};

/** Why a decision went to a person instead of being acted on: short badge, sentence on hover. */
const REASONS = {
  shadow: ["recommends only", "Warden could only recommend: it had not earned permission to act."],
  earning: ["on trial", "Warden was on trial: the evidence held, but it had not finished proving itself."],
  cap_full: ["cap full", "Three automatic blocks were already awaiting review, so everything else waits for a person."],
  stale_epoch: ["permission changed", "Permission was revoked while this page was being classified, so the verdict could not act."],
  rejected: ["answer rejected", "The model's answer failed validation, so it earned nothing and went to a person."],
  not_phishing: ["said legitimate", "The model said this page is not phishing, so there was nothing to act on."],
  uncertain: ["said unsure", "The model would not commit either way, so a person decides."],
  duplicate: ["already seen", "This page had already been decided here, so it counts once."],
};

/** What the permission check did with a decision. */
function checkBadge(route) {
  if (route.to === "block") {
    return el("span", { class: "badge blocked", title: "Warden blocked this URL on its own, with no person involved." }, "blocked");
  }
  const [short, full] = REASONS[route.reason] ?? [route.reason, route.reason];
  return el("span", { class: "badge", title: full }, short);
}

/** One summary tile. */
function tile(label, value, sub, extra) {
  return el(
    "div",
    { class: "tile" },
    el("div", { class: "label" }, label),
    el("div", { class: "value" }, value),
    sub ? el("div", { class: "sub" }, sub) : null,
    extra ?? null,
  );
}

/** The numbers an event was decided on. */
function tally(t) {
  return `${t.right} correct of ${t.right + t.wrong} · proven accuracy ${pct(t.bound)}`;
}

/** What each change actually means for what Warden may do next. */
const MEANING = {
  promoted: "From here on it may do more without asking.",
  demoted: "Back to recommending: nothing is blocked automatically until the evidence recovers.",
  probation_restarted: "The ten clean calls it needs must now start over.",
  revoked: "Everything it had earned is gone. It must build the whole record again from nothing.",
  reversed: "That URL is no longer blocked. A person's judgement undid what the AI did.",
};

/** The state change an event caused, shown as it moved: from one mode to the other. */
function transition(event) {
  const pairs = {
    promoted: [event.from, event.to],
    demoted: [event.from, "SHADOW"],
    revoked: ["AUTONOMOUS", "SHADOW"],
  };
  const pair = pairs[event.kind];
  if (!pair) return null;
  const [from, to] = pair;
  return el(
    "span",
    { class: "transition" },
    el("span", { class: `state ${from}` }, STATES[from].label),
    el("span", { class: "arrow" }, "→"),
    el("span", { class: `state ${to}` }, STATES[to].label),
  );
}

/** An event as a headline and the receipt behind it. */
function describe(recorded, urlOf) {
  const { event } = recorded;
  switch (event.kind) {
    case "promoted":
      return [`Permission raised: ${STATES[event.from].label} → ${STATES[event.to].label}`, tally(event.tally)];
    case "demoted":
      return ["Permission lowered: back to recommending only", tally(event.tally)];
    case "probation_restarted":
      return ["Trial restarted after a wrong call; the evidence still holds.", tally(event.tally)];
    case "revoked":
      return [
        "Permission revoked — it blocked something legitimate, so counting starts again from zero",
        `record at that moment: ${tally(event.tally)} · attempt ${event.tally.epoch} → ${event.nextEpoch}`,
      ];
    case "reversed":
      return [`Block undone: ${urlOf(recorded.decisionId)}`, "the page was legitimate, so the block was removed"];
    default:
      return [event.kind, ""];
  }
}

/** A demo run's progress in words. */
function runText(run) {
  if (run.status === "running") {
    const left = timeLeft(run);
    return `Running: page ${run.next} of ${run.total}${left ? ` · ${left}` : ""}`;
  }
  if (run.status === "done") return `Finished: all ${run.total} pages classified`;
  return `Stopped after ${run.next} of ${run.total} pages: ${run.reason}`;
}

// Which slice of the decision feed to show. "What mattered" is the default because the set
// is mostly campaign siblings: near-identical pages that nearly all go the same way.
const views = new Map();

/** Renders a record: run progress, summary tiles, events and the decision feed. Read-only —
 * judgements are given under Review, in one place rather than two. */
function renderLedger(container, state, { onLabel } = {}) {
  const urls = new Map(state.decisions.map((decision) => [decision.id, decision.url]));
  // A short record shows everything; only a long one needs filtering down to the story.
  const view = views.get(container.id) ?? (state.decisions.length > 20 ? "mattered" : "all");
  container.replaceChildren(
    ...(state.run ? [runProgress(state.run, state)] : []),
    ...standing(state),
    el("h3", {}, "What changed, and why"),
    eventList(state.events, (id) => urls.get(id) ?? "an unknown URL", container, state.decisions.length > 0),
    ...decisionFeed(state, view, container, onLabel),
  );
}

/** A demo run's status line, what it cost, and what its end state means. */
function runProgress(run, state) {
  const parts = [
    el("span", { class: `status ${run.status}` }, runText(run)),
    el("progress", { value: run.next, max: run.total }),
    ladder(state),
    story(state, run),
    el("div", { class: "cost" }, costOf(state.decisions.length)),
  ];
  const rebuilding = run.status === "done" && state.permission.epoch > 1 && state.permission.state === "SHADOW";
  if (rebuilding) {
    parts.push(
      el(
        "p",
        { class: "hint" },
        `This run ended part-way through starting over, which is why it finishes at "recommends only". ` +
          `Permission was revoked on attempt ${state.permission.epoch - 1}, and the remaining pages began rebuilding ` +
          `the record from zero. That is the design working, not the run failing.`,
      ),
    );
  }
  return el("div", { class: "run" }, ...parts);
}

/**
 * Where Warden stands. With no confirmed evidence there is nothing for a tile to report, and
 * a row of dashes reads as a broken status bar — so until there is, it says plainly what is
 * missing and what would change it.
 */
function standing(state) {
  const { permission, policy } = state;
  if (permission.right + permission.wrong > 0) {
    return [
      summaryTiles(state),
      el("p", { class: "hint" }, "Proven accuracy is recomputed in your browser from the counts above, using the server's own policy."),
    ];
  }

  const classified = state.decisions.length;
  const waiting = state.decisions.filter((decision) => decision.label === null).length;
  const uncountable = state.decisions.filter((decision) => decision.label !== null && !decision.counted).length;
  const needed = correctCallsStillNeeded(0, 0, policy);

  return [
    el(
      "div",
      { class: "standing" },
      el("p", {}, el("b", {}, "Warden has earned nothing here yet, so everything goes to you.")),
      el(
        "p",
        {},
        classified === 0
          ? "Nothing has been classified here yet."
          : `${classified} page${classified === 1 ? " has" : "s have"} been classified` +
              (waiting > 0 ? `, ${waiting} still waiting for you to confirm.` : "."),
      ),
      uncountable > 0
        ? el(
            "p",
            {},
            `${uncountable} confirmed judgement${uncountable === 1 ? "" : "s"} did not move the record. Only a verdict of `,
            el("b", {}, "phishing"),
            " counts towards it: being right that a page is harmless is easy, and counting it would flatter the numbers.",
          )
        : null,
      el(
        "p",
        { class: "muted" },
        `Starting from nothing, ${needed} confirmed-correct phishing verdicts are needed before Warden could be trusted to act alone. That is the point of the bar, and why the demo exists.`,
      ),
    ),
  ];
}

/** Where the run stands on the same ladder the front page explains, lit as it climbs. */
function ladder(state) {
  const rungs = [
    ["SHADOW", "Recommends only", "every verdict goes to a person"],
    ["EARNING", "On trial", "strong enough, not yet proved"],
    ["AUTONOMOUS", "Acts alone", "blocks URLs by itself"],
  ];
  const reached = new Set(["SHADOW"]);
  for (const recorded of state.events) {
    if (recorded.event.kind === "promoted") reached.add(recorded.event.to);
  }

  return el(
    "ol",
    { class: "ladder live" },
    rungs.flatMap(([key, name, note], index) => {
      const classes = ["rung", key.toLowerCase()];
      if (reached.has(key)) classes.push("been");
      if (state.permission.state === key) classes.push("here");
      const rung = el(
        "li",
        { class: classes.join(" ") },
        el("span", { class: "rung-name" }, name),
        el("span", { class: "rung-note" }, state.permission.state === key ? "← it is here now" : note),
      );
      if (index === rungs.length - 1) return [rung];
      return [rung, el("li", { class: "gate", "aria-hidden": "true" }, el("span", {}, index === 0 ? "73 confirmed correct" : "10 more in a row"))];
    }),
  );
}

/** The run as the story it is, so someone who looks away knows what they missed. */
function story(state, run) {
  const kinds = state.events.map((recorded) => recorded.event.kind);
  const promotions = state.events.filter((recorded) => recorded.event.kind === "promoted");
  const blocked = state.decisions.filter((decision) => decision.route.to === "block").length;
  const revoked = kinds.includes("revoked");
  const undone = kinds.filter((kind) => kind === "reversed").length;
  const capFull = state.decisions.filter((decision) => decision.route.reason === "cap_full").length;
  const running = run.status === "running";

  const beats = [
    [state.permission.right > 0, `Built a record — ${state.permission.right} confirmed-correct calls so far`],
    [promotions.some((p) => p.event.to === "EARNING"), "Cleared the bar, and went on trial"],
    [promotions.some((p) => p.event.to === "AUTONOMOUS"), "Passed the trial — allowed to act alone"],
    [blocked > 0, `Blocked ${blocked} URL${blocked === 1 ? "" : "s"} with no person involved`],
    [capFull > 0, `Hit the cap ${capFull} time${capFull === 1 ? "" : "s"} — three blocks awaiting review, so the rest queued`],
    [revoked, `Fooled by a planted instruction — permission revoked, ${undone} block${undone === 1 ? "" : "s"} undone`],
  ];
  const next = beats.find(([done]) => !done);

  return el(
    "ol",
    { class: "story" },
    beats.map(([done, text]) => el("li", { class: done ? "beat done" : "beat" }, text)),
    running && next ? el("li", { class: "beat waiting" }, `Waiting: ${next[1].toLowerCase()}`) : null,
  );
}

/**
 * Where the run has been, not only where it ended.
 *
 * The arc finishes back at "recommends only" — permission is revoked near the end and the
 * remaining pages start rebuilding. Anyone who looks only at the final state concludes it
 * never worked, when in fact it earned autonomy, used it, and lost it exactly as designed.
 */
function journey(state) {
  const reached = new Set(["SHADOW"]);
  for (const recorded of state.events) {
    if (recorded.event.kind === "promoted") reached.add(recorded.event.to);
  }
  const blocked = state.decisions.filter((decision) => decision.route.to === "block").length;
  const revocations = state.events.filter((recorded) => recorded.event.kind === "revoked").length;
  const undone = state.events.filter((recorded) => recorded.event.kind === "reversed").length;

  const steps = [
    ["SHADOW", "recommended only"],
    ["EARNING", "went on trial"],
    ["AUTONOMOUS", "acted alone"],
  ].map(([key, label]) =>
    el("span", { class: reached.has(key) ? `step reached ${key}` : "step" }, reached.has(key) ? `✓ ${label}` : label),
  );

  const outcome =
    revocations > 0
      ? `blocked ${blocked} URL${blocked === 1 ? "" : "s"} on its own, then lost the permission and undid ${undone}`
      : blocked > 0
        ? `blocked ${blocked} URL${blocked === 1 ? "" : "s"} on its own, permission intact`
        : "never earned the right to act";

  return el("div", { class: "journey" }, el("div", { class: "steps" }, steps), el("div", { class: "outcome" }, outcome));
}

/** The permission at a glance, in plain language, with the bound recomputed from its counts. */
function summaryTiles({ permission, policy, blocklist }) {
  const n = permission.right + permission.wrong;
  const bound = wilson(permission.right, n, policy.z);
  const stillNeeded = correctCallsStillNeeded(permission.right, permission.wrong, policy);
  const state = STATES[permission.state];
  const attempt =
    permission.epoch > 1 ? `attempt ${permission.epoch} — permission has been revoked ${permission.epoch - 1}×` : "first attempt";

  return el(
    "div",
    { class: "tiles" },
    tile("Can it act alone?", el("span", { class: `state ${permission.state}`, title: state.detail }, state.label), attempt),
    tile(
      "Accuracy we can prove",
      pct(bound),
      `needs ${pct(policy.requiredScore)} — the worst its true accuracy could plausibly be, not its average`,
      el("progress", { value: bound ?? 0, max: 1 }),
    ),
    tile("Confirmed correct", `${permission.right} of ${n}`, `${permission.wrong} wrong since the last reset`),
    tile(
      "Still needed",
      permission.state === "SHADOW" && stillNeeded !== null ? `${stillNeeded} more` : "none",
      "correct calls before it could be trusted to act",
    ),
    tile(
      "Trial progress",
      permission.state === "EARNING" ? `${permission.probation} of ${policy.probationLength}` : "—",
      "correct in a row before it may act alone",
    ),
    tile(
      "Blocks awaiting review",
      `${permission.unreviewed} of ${policy.maxUnreviewed}`,
      `${blocklist.length} URL${blocklist.length === 1 ? "" : "s"} blocked right now`,
    ),
  );
}

/** Promotions, revocations and reversals, each linking to the decision that caused it. */
function eventList(events, urlOf, container, hasDecisions) {
  if (events.length === 0) {
    return el(
      "p",
      { class: "empty" },
      hasDecisions
        ? "Warden's permission hasn't moved yet. Only a confirmed judgement changes it, so confirm a verdict above and this fills in."
        : "Nothing yet. This fills in as Warden gains or loses permission.",
    );
  }
  return el(
    "ul",
    { class: "events" },
    events.map((recorded) => {
      const [headline, receipt] = describe(recorded, urlOf);
      return el(
        "li",
        { class: recorded.event.kind },
        transition(recorded.event),
        el(
          "button",
          {
            type: "button",
            class: "event-link",
            title: "Show the decision that caused this",
            onclick: () => revealDecision(container, recorded.decisionId),
          },
          headline,
        ),
        el("span", { class: "meaning" }, MEANING[recorded.event.kind] ?? ""),
        el("span", { class: "receipt" }, receipt),
      );
    }),
  );
}

/** Switches to the full feed and highlights one decision, so an event can be traced to its cause. */
function revealDecision(container, decisionId) {
  views.set(container.id, "all");
  container.dispatchEvent(new CustomEvent("rerender"));
  requestAnimationFrame(() => {
    const row = container.querySelector(`[data-decision="${CSS.escape(decisionId)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.add("highlight");
  });
}

/** Whether a decision is worth a reviewer's attention, rather than one more of the same. */
function mattered(decision) {
  if (!decision.valid) return true;
  if (decision.verdict === "uncertain") return true;
  if (decision.label === "wrong") return true;
  if (decision.block === "reversed") return true;
  if (decision.route.to === "human" && ["cap_full", "stale_epoch", "duplicate"].includes(decision.route.reason)) return true;
  // A page blocked automatically and confirmed right, or recommended and confirmed right, is
  // the system working as expected — hundreds of those, and not one of them is news.
  return false;
}

/** The decision feed: heading, view switch, caption and table. */
function decisionFeed(state, view, container, onLabel) {
  const { decisions } = state;
  if (decisions.length === 0) return [el("h3", {}, "Decisions"), el("p", { class: "empty" }, "Nothing classified yet.")];

  const showing =
    view === "campaigns"
      ? new Set(decisions.map((d) => corpus.byUrl.get(d.url)?.campaign ?? "unknown")).size
      : (view === "mattered" ? decisions.filter(mattered) : decisions.slice(-120)).length;
  const label =
    view === "campaigns"
      ? `Decisions — ${showing} campaign${showing === 1 ? "" : "s"}, ${decisions.length} page${decisions.length === 1 ? "" : "s"}`
      : `Decisions — showing ${showing} of ${decisions.length}`;
  const heading = el(
    "div",
    { class: "section-head" },
    el("h3", {}, label),
    el(
      "div",
      { class: "views" },
      viewButton("mattered", "What mattered", view, container),
      viewButton("campaigns", "By campaign", view, container),
      viewButton("all", "Everything", view, container),
    ),
  );
  const caption = el("p", { class: "note" }, captionFor(view, state));

  if (view === "campaigns") return [heading, caption, campaignTable(decisions)];

  const shown = view === "mattered" ? decisions.filter(mattered) : decisions.slice(-120);
  if (shown.length === 0) {
    return [heading, caption, el("p", { class: "empty" }, "Nothing unexpected happened — every call went as intended.")];
  }
  return [heading, caption, decisionTable(shown.slice().reverse(), onLabel)];
}

/** Explains what the current view shows, and where these pages came from. */
function captionFor(view, state) {
  const built = corpus.summary
    ? `These are ${corpus.summary.pages} pages written for this project — ${corpus.summary.techniques} hand-written techniques, expanded into ${corpus.summary.campaigns} campaigns of near-identical pages on different domains, the way a real phishing kit is deployed across many hosts. None is a copy of a real page.`
    : "";
  if (view === "campaigns") return `${built} Grouped by campaign, since siblings share a technique and nearly always go the same way.`;
  if (view === "all") return `${built} Every decision, newest first.`;
  const hidden = state.decisions.length - state.decisions.filter(mattered).length;
  return `${built} Showing only what a reviewer would want: mistakes, rejected answers, pages Warden refused to act on, and blocks that were undone. ${hidden} routine calls are hidden.`;
}

/** One of the three view switches. */
function viewButton(id, label, current, container) {
  return el(
    "button",
    {
      type: "button",
      class: id === current ? "view current" : "view",
      onclick: () => {
        views.set(container.id, id);
        container.dispatchEvent(new CustomEvent("rerender"));
      },
    },
    label,
  );
}

/** One row per campaign: the padding collapsed into counts. */
function campaignTable(decisions) {
  const families = new Map();
  for (const decision of decisions) {
    const page = corpus.byUrl.get(decision.url);
    const key = page?.campaign ?? "unknown";
    const family = families.get(key) ?? { key, technique: page?.technique ?? "—", pages: 0, right: 0, wrong: 0, blocked: 0, unusable: 0 };
    family.pages++;
    if (decision.label === "right") family.right++;
    if (decision.label === "wrong") family.wrong++;
    if (decision.route.to === "block") family.blocked++;
    if (!decision.valid || decision.verdict === "uncertain") family.unusable++;
    families.set(key, family);
  }

  const head = el(
    "thead",
    {},
    el("tr", {}, ["Campaign", "Technique", "Pages", "Correct", "Wrong", "Blocked", "Unusable"].map((t) => el("th", {}, t))),
  );
  const body = el(
    "tbody",
    {},
    [...families.values()].map((family) =>
      el(
        "tr",
        {},
        el("td", {}, family.key),
        el("td", { class: "muted" }, family.technique),
        el("td", {}, String(family.pages)),
        el("td", { class: "label-right" }, String(family.right)),
        el("td", { class: family.wrong > 0 ? "label-wrong" : "muted" }, String(family.wrong)),
        el("td", {}, String(family.blocked)),
        el("td", { class: "muted" }, String(family.unusable)),
      ),
    ),
  );
  return el("div", { class: "feed" }, el("table", {}, head, body));
}

/** The decision table, newest first. */
function decisionTable(shown, onLabel) {
  const head = el(
    "thead",
    {},
    el("tr", {}, ["Page", "Verdict", "Evidence cited", "Allowed to", "Block", "Confirmed"].map((t) => el("th", {}, t))),
  );
  const body = el("tbody", {}, shown.map((decision) => feedRow(decision, onLabel)));
  return el("div", { class: "feed" }, el("table", {}, head, body));
}

/** One decision: what the page is, what the model said, and what it was allowed to do. */
function feedRow(decision, onLabel) {
  return el(
    "tr",
    { "data-decision": decision.id },
    el("td", {}, pageCell(decision)),
    el("td", {}, verdictCell(decision)),
    el("td", {}, evidenceCell(decision)),
    el("td", {}, checkBadge(decision.route)),
    el("td", {}, blockCell(decision)),
    el("td", {}, labelCell(decision, onLabel)),
  );
}

/** What the page is, with its URL underneath. A known test page says what it really is. */
function pageCell(decision) {
  const page = corpus.byUrl.get(decision.url);
  const url = el("div", { class: "url", title: decision.url }, decision.url);
  if (!page) return url;
  const truth = el(
    "span",
    { class: page.truth === "phishing" ? "truth-phishing" : "truth-legitimate" },
    page.truth === "phishing" ? "really phishing" : "really legitimate",
  );
  return [el("div", { class: "technique" }, page.technique), truth, url];
}

/** The verdict, with the model's own stated confidence shown as just that. */
function verdictCell(decision) {
  const verdict = el("span", { class: `verdict-${decision.verdict}` }, decision.verdict.replace("_", " "));
  if (decision.confidence === null) return verdict;
  const stated = el(
    "div",
    { class: "muted", title: "The model's own stated confidence. Recorded, but it decides nothing." },
    `it claims ${Math.round(decision.confidence * 100)}%`,
  );
  return [verdict, stated];
}

/** The signals a verdict cited, or why its answer was rejected. */
function evidenceCell(decision) {
  if (!decision.valid) {
    return el("span", { class: "rejected", title: "The answer failed validation, so it earned nothing." }, `rejected: ${decision.rejection}`);
  }
  if (decision.citedSignals.length === 0) return el("span", { class: "muted" }, "none cited");
  return decision.citedSignals.map((id) => el("span", { class: "chip" }, id));
}

/** Whether the decision's block still stands. */
function blockCell(decision) {
  if (!decision.block) return el("span", { class: "muted" }, "—");
  const title =
    decision.block === "reversed" ? "This block was undone after the page turned out to be legitimate." : "This URL is blocked.";
  return el("span", { class: `block-${decision.block}`, title }, decision.block === "reversed" ? "undone" : "in place");
}

/** The confirmed answer, or a note saying where to give one. */
function labelCell(decision, onLabel) {
  if (decision.label) {
    const title =
      decision.label === "right"
        ? "Confirmed: the verdict matched what the page really is."
        : "Confirmed wrong: the verdict did not match what the page really is.";
    return el("span", { class: `label-${decision.label}`, title }, decision.label === "right" ? "verdict correct" : "verdict wrong");
  }
  if (!onLabel) return el("span", { class: "muted" }, "not yet judged");
  return el(
    "div",
    { class: "actions" },
    el("button", { type: "button", class: "secondary", onclick: () => onLabel(decision.id, "right") }, "Correct"),
    el("button", { type: "button", class: "secondary", onclick: () => onLabel(decision.id, "wrong") }, "Wrong"),
    decision.counted ? null : el("div", { class: "muted", title: "Only a verdict of phishing counts towards the record." }, "won't move the record"),
  );
}

// Demo runs.
let demoTimer;
let lastDemoState = null;
// Measured progress, so "how much longer" is an observation rather than a guess.
let pace = null;

/** Roughly how long is left, from the rate this run has actually managed. */
function timeLeft(run) {
  const now = Date.now();
  if (!pace || pace.runId !== run.runId) pace = { runId: run.runId, at: now, done: run.next };
  const elapsed = now - pace.at;
  const progressed = run.next - pace.done;
  if (elapsed < 4000 || progressed <= 0) return null;
  const seconds = Math.round(((run.total - run.next) * elapsed) / progressed / 1000);
  if (seconds < 20) return "nearly done";
  return `about ${Math.ceil(seconds / 30) * 30} seconds left`;
}

$("demo").addEventListener("rerender", () => {
  if (lastDemoState) renderLedger($("demo"), lastDemoState);
});

/** Shows a demo run and keeps polling it while it runs. */
async function watchDemo(runId) {
  clearTimeout(demoTimer);
  const res = await api("GET", `/demo/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return demoUnavailable(res);

  lastDemoState = { ...res.data, run: res.data.run ? { ...res.data.run, runId } : res.data.run };
  renderLedger($("demo"), lastDemoState);
  const running = res.data.run?.status === "running";
  $("run-demo").disabled = running;
  $("run-demo").textContent = running ? "Running…" : res.data.run ? "Run it again" : "Run the demo";
  $("clear-demo").hidden = running || !res.data.run;
  if (running) demoTimer = setTimeout(() => watchDemo(runId), 1500);
}

/** Explains why a demo run can't be shown, and forgets a run the server doesn't know. */
function demoUnavailable(res) {
  $("demo").replaceChildren(el("p", { class: "error" }, explain(res)));
  $("run-demo").disabled = false;
  if (res.status === 404) store(RUN_KEY, "");
}

$("run-demo").addEventListener("click", async () => {
  $("run-demo").disabled = true;
  const res = await api("POST", "/demo/runs");
  if (!res.ok) return demoUnavailable(res);
  store(RUN_KEY, res.data.runId);
  watchDemo(res.data.runId);
});

// The live ledger.
let lastLiveState = null;

$("live").addEventListener("rerender", () => {
  if (lastLiveState) renderLedger($("live"), lastLiveState, { onLabel: labelLive });
});

/** Loads and shows the live ledger and the review queue. */
async function loadLive() {
  const res = await api("GET", "/live");
  if (!res.ok) {
    $("live").replaceChildren(el("p", { class: res.status === 503 ? "empty" : "error" }, explain(res)));
    return;
  }
  lastLiveState = res.data;
  showLiveStatus(res.data.permission);
  const waiting = res.data.decisions.filter((decision) => decision.label === null).length;
  $("queue-count").textContent = waiting === 0 ? "" : String(waiting);
  renderLedger($("live"), res.data, { onLabel: labelLive });
}


/**
 * What the live system is allowed to do, in the masthead, colour-coded and on every page.
 * It is the one fact a viewer should never have to go looking for.
 */
function showLiveStatus(permission) {
  const state = STATES[permission.state];
  const mode = $("live-status-mode");
  mode.textContent = state.label;
  mode.className = `live-status-mode ${permission.state}`;
  $("live-status").title = `${state.detail}${permission.epoch > 1 ? ` Permission has been revoked ${permission.epoch - 1}×.` : ""}`;
}

/** Records a person's judgement of a live decision, then reloads the ledger. */
async function labelLive(decisionId, label) {
  const decision = lastLiveState?.decisions.find((candidate) => candidate.id === decisionId);
  const res = await api("POST", "/live/labels", { decisionId, label });
  if (!res.ok) {
    showBanner(explain(res));
    return;
  }
  // Without this, confirming a "not phishing" verdict leaves every number untouched and the
  // page looks broken. It isn't: that verdict was never going to count.
  showBanner(
    decision && !decision.counted
      ? "Saved. The figures below are unchanged, which is expected: only a verdict of phishing counts towards Warden's record."
      : "Saved.",
    "info",
  );
  await loadLive();
}

$("refresh-live").addEventListener("click", loadLive);

// Each demo run already gets its own ledger, so running again is the reset. Clearing only
// stops showing the old one, and costs nothing.
$("clear-demo").addEventListener("click", () => {
  store(RUN_KEY, "");
  lastDemoState = null;
  clearTimeout(demoTimer);
  $("demo").replaceChildren(el("p", { class: "empty" }, "No run yet."));
  $("clear-demo").hidden = true;
  $("run-demo").textContent = "Run the demo";
});

$("reset-live").addEventListener("click", async () => {
  const waiting = lastLiveState?.decisions.length ?? 0;
  if (waiting > 0 && !confirm(`Delete this record? ${waiting} decision${waiting === 1 ? "" : "s"} and everything Warden has earned here will be gone.`)) {
    return;
  }
  const res = await api("POST", "/live/reset");
  showBanner(res.ok ? "Record cleared. Warden starts again with no permission to act." : explain(res), res.ok ? "info" : "error");
  await loadLive();
});

// Sending Warden a page.

/** Fills the picker with one page per technique, so nobody has to invent HTML. */
function fillPicker() {
  const picker = $("try-pick");
  if (!picker || corpus.techniques.length === 0) return;
  picker.append(...corpus.techniques.map((page) => el("option", { value: page.id }, `${page.technique} — really ${page.truth}`)));
}

// Where the source in the box came from, so an edited URL with somebody else's HTML still
// sitting underneath it can be caught before it produces a verdict about the wrong page.
let loadedPage = null;

$("try-pick").addEventListener("change", async (event) => {
  const chosen = corpus.techniques.find((page) => page.id === event.target.value);
  if (!chosen) return;
  const res = await api("GET", `/corpus/pages/${encodeURIComponent(chosen.id)}`);
  if (!res.ok) return showBanner(explain(res));
  $("try-url").value = res.data.url;
  $("try-html").value = res.data.html;
  loadedPage = { url: res.data.url, html: res.data.html };
  $("try-advanced").open = true;
  $("try-result").replaceChildren();
  checkMismatch();
});

/**
 * Warns when the URL has been changed but the loaded page source has not. Warden judges the
 * source, so that combination silently produces a verdict about a completely different page.
 */
function checkMismatch() {
  const stale =
    loadedPage !== null && $("try-html").value.trim() !== "" && $("try-html").value === loadedPage.html && $("try-url").value !== loadedPage.url;
  const warning = $("try-mismatch");
  warning.hidden = !stale;
  if (stale) {
    warning.textContent =
      "The source below is still the test page you loaded, but the URL has changed — so Warden would judge that page and record it under your URL. Clear the source to fetch the URL instead.";
  }
}

$("try-url").addEventListener("input", () => {
  $("try-pick").value = "";
  checkMismatch();
});
$("try-html").addEventListener("input", () => {
  loadedPage = null;
  checkMismatch();
});

/** A definition-list row. */
function row(term, ...definition) {
  return [el("dt", {}, term), el("dd", {}, ...definition)];
}

/** What happened to a page, step by step, so the flow is visible rather than implied. */
function renderClassification(d) {
  const excerpt = d.excerpt.length > 300 ? `${d.excerpt.slice(0, 300)}…` : d.excerpt;
  const stated = d.confidence === null ? "" : ` — it claims ${Math.round(d.confidence * 100)}% confidence, which decides nothing`;
  const step = (n, title, ...body) =>
    el("li", {}, el("div", { class: "step-title" }, `${n}. ${title}`), el("div", { class: "step-body" }, ...body));

  return el(
    "div",
    { class: "result" },
    el(
      "ol",
      { class: "pipeline" },
      d.fetched
        ? step("0", "Warden fetched the page", el("span", { class: "muted" }, "https only, redirects re-checked at every hop, nothing aimed at a private address"))
        : step("0", "You supplied the page source", el("span", { class: "muted" }, "nothing was fetched")),
      step(
        "1",
        "Signals extracted from the page",
        chips(d.signals),
        el("div", { class: "muted" }, `plus ${d.excerpt.length} characters of its text, given to the model as data, never as instructions`),
      ),
      step(
        "2",
        "The model gave a verdict",
        el("span", { class: `verdict-${d.verdict ?? "none"}` }, d.verdict ?? "none"),
        stated,
        d.reasoning ? el("div", { class: "muted" }, d.reasoning) : null,
      ),
      step(
        "3",
        "Its evidence was checked against the page",
        d.valid
          ? el("span", {}, "every signal it cited was really found: ", chips(d.citedSignals.map((id) => ({ id }))))
          : el("span", { class: "rejected" }, `rejected — ${d.rejection}. It earns nothing and goes to a person.`),
      ),
      step(
        "4",
        "Permission was checked",
        checkBadge(d.route),
        " ",
        el("span", { class: "muted" }, (REASONS[d.route.reason] ?? [])[1] ?? "Warden blocked this URL on its own."),
      ),
      step(
        "5",
        "Waiting for your judgement",
        "Nothing about Warden's record has changed yet. Confirming whether this verdict was right is the only thing that moves it.",
      ),
    ),
    el(
      "div",
      { class: "next-step" },
      el(
        "button",
        {
          type: "button",
          onclick: () => {
            window.location.hash = "#review";
            requestAnimationFrame(() => highlightNewest(d.decisionId));
          },
        },
        "Judge this verdict →",
      ),
      el("span", { class: "muted" }, "under Review, where everything awaiting you is listed"),
    ),
    el("dl", {}, row("Page text the model saw", el("span", { class: "muted" }, excerpt))),
  );
}

/** Scrolls the just-classified decision into view under Review, so it isn't hunted for. */
function highlightNewest(decisionId) {
  const row = $("live").querySelector(`[data-decision="${CSS.escape(decisionId)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("highlight");
}

/** Signal ids as chips, with any detail as a tooltip. */
function chips(signals) {
  if (signals.length === 0) return el("span", { class: "muted" }, "none");
  return signals.map((signal) => el("span", { class: "chip", title: signal.detail }, signal.id));
}

$("try-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter ?? $("try-form").querySelector("button");
  submit.disabled = true;
  const html = $("try-html").value.trim();
  $("try-result").replaceChildren(
    el("p", { class: "empty" }, html === "" ? "Fetching the page, then classifying — this is a live model call…" : "Classifying — this is a live model call…"),
  );
  const res = await api("POST", "/classify", html === "" ? { url: $("try-url").value } : { url: $("try-url").value, html });
  submit.disabled = false;

  if (!res.ok) return $("try-result").replaceChildren(el("p", { class: "error" }, explain(res)));
  $("try-result").replaceChildren(renderClassification(res.data));
  loadLive();
});

// Four pages rather than one long scroll. The number waiting to be reviewed shows on its
// tab from wherever you are, because that is the one thing needing a person.
const PAGES = [
  ["nav-about", "page-about"],
  ["nav-try", "page-try"],
  ["nav-review", "page-review"],
  ["nav-demo", "page-demo"],
];

/** Shows one page and hides the rest. */
function showPage(chosen) {
  for (const [nav, page] of PAGES) {
    const current = nav === chosen;
    $(nav).classList.toggle("current", current);
    if (current) $(nav).setAttribute("aria-current", "page");
    else $(nav).removeAttribute("aria-current");
    $(page).hidden = !current;
  }
  window.scrollTo({ top: 0 });
}

/** The address bar names the page, so a refresh or a shared link lands in the same place. */
const ROUTES = { "#how-it-works": "nav-about", "#send": "nav-try", "#review": "nav-review", "#demo": "nav-demo" };

function routeFromHash() {
  showPage(ROUTES[window.location.hash] ?? "nav-about");
}

for (const [nav] of PAGES) {
  const hash = Object.keys(ROUTES).find((key) => ROUTES[key] === nav);
  $(nav).addEventListener("click", () => {
    window.location.hash = hash;
  });
}

window.addEventListener("hashchange", routeFromHash);
routeFromHash();

loadCorpus();
loadLive();
setInterval(loadLive, 15_000);
const lastRun = stored(RUN_KEY);
if (lastRun) watchDemo(lastRun);
