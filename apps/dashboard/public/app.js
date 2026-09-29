// Warden's dashboard.
//
// Much of what it shows was written by whoever controls a reported page, so it is only ever
// inserted as text, never as markup, and no link is ever built from a page's URL. Styling is
// all in the stylesheet: the page's policy refuses inline style attributes, so the few sizes
// that depend on data are set through the CSSOM instead.

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

/** Sets one CSS property through the CSSOM, which the page's policy allows where an inline style attribute isn't. */
function styled(node, property, value) {
  node.style.setProperty(property, value);
  return node;
}

// The last run this browser watched, so a bare #score reopens it. The address bar is what
// really carries a run (#score/<id>), so a link works in any browser. No credential is ever
// held here: a local run needs none, and a deployed one is driven with its token instead.
const RUN_KEY = "warden-demo-run";

/** Reads a remembered value, or "" when there is none or storage is blocked. */
function stored(key) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/** Remembers a value; an empty value removes it. Storage is a convenience, so failures are ignored. */
function store(key, value) {
  try {
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, value);
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
const corpus = { byUrl: new Map(), byId: new Map(), summary: null, techniques: [] };

/** Loads what the test pages are, and fills the picker. */
async function loadCorpus() {
  const res = await api("GET", "/corpus");
  if (!res.ok) return;
  corpus.summary = res.data.summary;
  corpus.techniques = res.data.techniques;
  for (const page of res.data.pages) {
    corpus.byUrl.set(page.url, page);
    corpus.byId.set(page.id, page);
  }
  for (const slot of document.querySelectorAll(".corpus-size")) slot.textContent = String(corpus.summary.pages);
  fillPicker();
  // Either record may have been drawn before this arrived, with URLs where page names belong.
  $("live").dispatchEvent(new CustomEvent("rerender"));
  $("demo").dispatchEvent(new CustomEvent("rerender"));
}

// Where an example page is served from on this Worker, which is the URL it has when sent from
// the picker rather than walked in a scoring run.
const SERVED_EXAMPLE = /^\/corpus\/pages\/([^/]+)\/source$/;

/** The corpus page a decision's URL is, whether by its own URL or the one this Worker serves it at; null for anything else. */
function pageOf(url) {
  const known = corpus.byUrl.get(url);
  if (known) return known;
  try {
    const served = SERVED_EXAMPLE.exec(new URL(url).pathname);
    return served ? (corpus.byId.get(decodeURIComponent(served[1])) ?? null) : null;
  } catch {
    return null;
  }
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

/** How many more correct calls it takes before the proven precision reaches the bar. */
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

/**
 * A bound as a percentage, with as many decimals as it takes to show which side of the bar
 * it is on. 94.976% rounds to "95.0%", which next to a 95.0% bar and a "Not yet" reads as a
 * contradiction; within a tenth of a point of the bar it gets at least two decimals, and more
 * until the rounded figure falls on the same side as the real one.
 */
function boundPct(value, bar) {
  if (value === null || value === undefined) return "—";
  const close = Math.abs(value - bar) < 0.001;
  for (let decimals = close ? 2 : 1; decimals < 6; decimals++) {
    const shown = Number((value * 100).toFixed(decimals)) / 100;
    if (value < bar === shown < bar) return `${(value * 100).toFixed(decimals)}%`;
  }
  return `${(value * 100).toFixed(6)}%`;
}

/** "1 page", "2 pages". */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What each permission state means, without the vocabulary. */
const STATES = {
  SHADOW: { label: "Recommends only", detail: "Everything goes to a person. Nothing is blocked automatically." },
  EARNING: { label: "On trial", detail: "The evidence is strong enough, but it must hold before it may act." },
  AUTONOMOUS: { label: "Acts alone", detail: "It may block a URL by itself, within the limits shown." },
  // Reported, not stored: SHADOW whose record puts the ceiling on its precision under the bar.
  UNQUALIFIABLE: {
    label: "Can't qualify",
    detail: "Everything goes to a person, and on this evidence the bar is out of reach: more of the same won't clear it.",
  },
};

/**
 * Why a decision went to a person instead of being acted on: short badge, sentence on hover,
 * and a tone for its dot — held back by the rules, refused outright, or simply not asked.
 */
const REASONS = {
  shadow: ["recommends only", "Warden could only recommend: it had not earned permission to act.", ""],
  earning: ["on trial", "Warden was on trial: the evidence held, but it had not finished proving itself.", "held"],
  cap_full: ["cap full", "Three automatic blocks were already awaiting review, so everything else waits for a person.", "held"],
  stale_epoch: ["permission changed", "Permission was revoked while this page was being classified, so the verdict could not act.", "refused"],
  rejected: ["answer rejected", "The model's answer failed validation, so it earned nothing and went to a person.", "refused"],
  not_phishing: ["said legitimate", "The model said this page is not phishing, so there was nothing to act on.", ""],
  uncertain: ["said unsure", "The model would not commit either way, so a person decides.", ""],
  duplicate: ["already seen", "This page had already been decided here, so it counts once.", ""],
};

/**
 * What became of a decision, as an outcome rather than a reason. "Cap full" answers a
 * different question from the one the column asks; "sent to a person — cap full" answers it.
 */
function checkBadge(route) {
  if (route.to === "block") {
    return el("span", { class: "badge blocked", title: "Warden blocked this URL on its own, with no person involved." }, "blocked automatically");
  }
  const [short, full, tone] = REASONS[route.reason] ?? [route.reason, route.reason, ""];
  return el("span", { class: `badge ${tone}`, title: full }, `sent to a person — ${short}`);
}

/** A bar filled to `fraction`, with an optional marker at `mark` (both 0–1). */
function meter(fraction, mark) {
  const fill = styled(el("div", { class: "meter-fill" }), "width", `${Math.max(0, Math.min(1, fraction)) * 100}%`);
  const marker = mark === undefined ? null : styled(el("div", { class: "meter-mark" }), "left", `${mark * 100}%`);
  return el("div", { class: "meter", "aria-hidden": "true" }, fill, marker);
}

/** One summary tile: label, value, an optional picture of it, and a line of explanation. */
function tile(label, value, sub, picture, { dim = false } = {}) {
  return el(
    "div",
    { class: "tile" },
    el("div", { class: "label" }, label),
    el("div", { class: dim ? "value dim" : "value" }, value),
    picture ?? null,
    sub ? el("div", { class: "sub" }, sub) : null,
  );
}

/** The numbers an event was decided on. */
function tally(t, bar) {
  return `${t.right} correct of ${t.right + t.wrong} · proven precision ${boundPct(t.bound, bar)}`;
}

/** What each change actually means for what Warden may do next. */
const MEANING = {
  promoted: "From here on it may do more without asking.",
  demoted: "Back to recommending: nothing is blocked automatically until the evidence recovers.",
  probation_restarted: "The ten clean calls it needs must now start over.",
  revoked: "Everything it had earned is gone. It must build the whole record again from nothing.",
  reversed: "That URL is no longer blocked. A person's judgement undid what the AI did.",
};

/** A short name for each kind of change, for the history's left-hand column. */
const KINDS = {
  promoted: "promoted",
  demoted: "demoted",
  probation_restarted: "trial reset",
  revoked: "revoked",
  reversed: "reversed",
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
function describe(recorded, urlOf, bar) {
  const { event } = recorded;
  switch (event.kind) {
    case "promoted":
      return [`Permission raised: ${STATES[event.from].label} → ${STATES[event.to].label}`, tally(event.tally, bar)];
    case "demoted":
      return ["Permission lowered: back to recommending only", tally(event.tally, bar)];
    case "probation_restarted":
      return ["Trial restarted after a wrong call; the evidence still holds.", tally(event.tally, bar)];
    case "revoked":
      return [
        "Permission revoked — it blocked something legitimate, so counting starts again from zero",
        `record at that moment: ${tally(event.tally, bar)} · attempt ${event.tally.epoch} → ${event.nextEpoch}`,
      ];
    case "reversed":
      return [`Block undone: ${urlOf(recorded.decisionId)}`, "the page was legitimate, so the block was removed"];
    default:
      return [event.kind, ""];
  }
}

/** A scoring run's progress in words. */
function runText(run) {
  if (run.status === "running") {
    const left = timeLeft(run);
    return `Scoring: page ${run.next} of ${run.total}${left ? ` · ${left}` : ""}`;
  }
  if (run.status === "done") return `Scored: all ${run.total} pages classified`;
  return `Stopped after ${run.next} of ${run.total} pages: ${run.reason}`;
}

// Which slice of the decision feed to show, per record.
const views = new Map();

/** Renders the live record: where it stands, what changed, and the decisions. */
function renderLedger(container, state, { onLabel } = {}) {
  if (state.decisions.length === 0) {
    container.replaceChildren(recordPanel(state), placeholders());
    return;
  }
  const urls = new Map(state.decisions.map((decision) => [decision.id, decision.url]));
  // A short record shows everything; only a long one needs filtering down to the story.
  const view = views.get(container.id) ?? (state.decisions.length > 20 ? "campaigns" : "all");
  const climb = climbPanel(state);
  const events =
    climb && state.events.length === 0
      ? null
      : eventList(state.events, (id) => urls.get(id) ?? "an unknown URL", container, true, state.policy.requiredScore);
  container.replaceChildren(
    recordPanel(state),
    el("div", { class: "section" }, el("h3", {}, "What changed, and why"), climb, events),
    decisionFeed(state, view, container, onLabel),
  );
}

// The chart labels each bar only while there are few enough to read; past that, just the last.
const LABELLED_BARS = 12;

/**
 * The record replayed judgement by judgement: the proven precision after each one that
 * counted in this attempt, against the bar. Recomputed here from the ledger's own labels, in
 * the order they were given, so its last bar is exactly the figure in the tiles above.
 */
function climbPanel(state) {
  const { permission, policy } = state;
  const counted = (state.judgements ?? []).filter((judgement) => judgement.counted && judgement.epoch === permission.epoch);
  if (counted.length === 0) return null;

  let right = 0;
  let wrong = 0;
  const points = counted.map((judgement) => {
    if (judgement.label === "right") right++;
    if (judgement.label === "wrong") wrong++;
    return { judgement, right, wrong, bound: wilson(right, right + wrong, policy.z) ?? 0 };
  });

  const bar = styled(el("div", { class: "climb-bar-line" }), "bottom", `${policy.requiredScore * 100}%`);
  const columns = points.map((point, index) => climbColumn(point, index, points.length, policy.requiredScore));
  const chart = el("div", { class: points.length > 40 ? "climb-chart dense" : "climb-chart" }, bar, columns);

  return el(
    "div",
    { class: "climb" },
    el(
      "div",
      { class: "climb-head" },
      el("span", {}, "proven precision after each confirmed judgement"),
      el("span", { class: "legend" }, el("span", { class: "legend-line", "aria-hidden": "true" }), `${pct(policy.requiredScore)} bar`),
    ),
    el("div", { class: "climb-frame", role: "img", "aria-label": climbSummary(points, policy) }, chart),
    changes(state, counted.length),
  );
}

/** One judgement's bar, its height the proven precision after it, its time on hover. */
function climbColumn(point, index, total, bar) {
  const last = index === total - 1;
  const classes = ["climb-bar"];
  if (point.judgement.label === "wrong") classes.push("wrong");
  if (last) classes.push("last");
  const at = new Date(point.judgement.labelledAt).toLocaleString();
  const column = styled(
    el("div", {
      class: classes.join(" "),
      title: `Judgement ${index + 1} · ${at} · verdict ${point.judgement.label} · ${point.right} of ${point.right + point.wrong} · proven ${boundPct(point.bound, bar)}`,
    }),
    "height",
    `${point.bound * 100}%`,
  );
  if (last || total <= LABELLED_BARS) column.append(el("span", { class: "climb-label" }, boundPct(point.bound, bar)));
  return el("div", { class: "climb-col" }, column);
}

/** The chart in a sentence, for anyone who can't see it. */
function climbSummary(points, policy) {
  const first = points[0];
  const last = points[points.length - 1];
  const bar = policy.requiredScore;
  return `Proven precision over ${plural(points.length, "judgement")}, from ${boundPct(first.bound, bar)} to ${boundPct(last.bound, bar)}, against a bar of ${pct(bar)}.`;
}

/** Where each state leaves Warden, as the end of a sentence. */
const STAYS = {
  SHADOW: "Warden stays at Recommends only",
  EARNING: "Warden is on trial",
  AUTONOMOUS: "Warden may act alone",
  UNQUALIFIABLE: "on this evidence Warden can't qualify",
};

/** The record in three lines under the chart: where it stands, what didn't count, and where this attempt began. */
function changes(state, countedInAttempt) {
  const { permission, policy } = state;
  const n = permission.right + permission.wrong;
  const bound = wilson(permission.right, n, policy.z);
  const clears = bound !== null && bound >= policy.requiredScore;
  const uncounted = (state.judgements ?? []).filter((judgement) => !judgement.counted).length;
  const rows = [
    [
      "now",
      `Confirmed ${permission.right} of ${plural(n, "phishing verdict")} correct. Proven precision ${boundPct(bound, policy.requiredScore)}, ` +
        `${clears ? "at or above" : "still under"} ${pct(policy.requiredScore)}, so ${STAYS[standingOf(state)]}.`,
    ],
    uncounted > 0
      ? ["other", `Confirmed ${plural(uncounted, "verdict")} that could not count: only a phishing verdict moves the record.`]
      : null,
    [
      "start",
      permission.epoch === 1
        ? "First attempt. No permission."
        : `Attempt ${permission.epoch}. Permission was revoked ${permission.epoch - 1}×, so the record began again from zero; ${plural(countedInAttempt, "judgement")} have counted since.`,
    ],
  ];
  return el(
    "div",
    { class: "changes" },
    rows.filter(Boolean).map(([when, text]) => el("div", { class: "change" }, el("span", { class: "change-when" }, when), el("span", {}, text))),
  );
}

/** What an empty record has yet to show, as outlines of the sections that will fill in. */
function placeholders() {
  return el(
    "div",
    { class: "placeholders" },
    el(
      "div",
      { class: "placeholder" },
      el("h3", {}, "What changed, and why"),
      el("p", { class: "empty" }, "Nothing yet. This fills in as Warden gains or loses permission."),
    ),
    el("div", { class: "placeholder" }, el("h3", {}, "Decisions"), el("p", { class: "empty" }, "Nothing classified yet.")),
  );
}

/**
 * Renders a scoring run as the evaluation it is: the result first, then the result broken
 * down by campaign, then — set apart — what that precision would do to permission on live
 * traffic, rehearsed on the run's own throwaway ledger.
 */
function renderEvaluation(container, state) {
  const urls = new Map(state.decisions.map((decision) => [decision.id, decision.url]));
  // By campaign is the result; the other views are there to dig into it.
  const view = views.get(container.id) ?? "campaigns";
  container.replaceChildren(
    runStatus(state.run, state),
    el("div", { class: "section-eyebrow" }, "1 · The answer: is this model, prompt and policy good enough?"),
    resultPanel(state),
    el("div", { class: "section-eyebrow" }, "2 · The same answer, campaign by campaign"),
    decisionFeed(state, view, container),
    el(
      "div",
      { class: "arc" },
      el("div", { class: "section-eyebrow" }, "3 · What that would mean for permission: a rehearsal"),
      el("p", { class: "arc-summary" }, rehearsalOutcome(state)),
      el(
        "p",
        { class: "sandbox" },
        el("strong", {}, "A rehearsal, not a grant. "),
        "The same pages, replayed through Warden's permission rules on a throwaway ledger as if each were a real report " +
          "and each known answer an analyst's judgement. Nothing here carries over: the live system, top right, earns " +
          "its own permission under Review.",
      ),
      ladder(state),
      story(state, state.run),
      ...(state.permission.right + state.permission.wrong > 0 ? [el("h4", {}, "Where the rehearsal ended"), summaryTiles(state)] : []),
      el("h4", {}, "What changed, and why"),
      // Known answers do the confirming here, so the prompt to confirm a verdict doesn't apply.
      eventList(state.events, (id) => urls.get(id) ?? "an unknown URL", container, false, state.policy.requiredScore),
    ),
  );
}

/** Before any run: a quiet placeholder where the result will appear. */
function emptyScore() {
  const bars = Array.from({ length: 22 }, (_, i) =>
    styled(el("span"), "height", `${6 + Math.round(Math.abs(Math.sin(i * 1.7)) * 20)}px`),
  );
  return el(
    "div",
    { class: "empty-state" },
    el("div", { class: "empty-bars", "aria-hidden": "true" }, bars),
    el("p", {}, "Nothing scored yet."),
  );
}

/** A scoring run's status line, progress and what it has cost so far. */
function runStatus(run, state) {
  return el(
    "div",
    { class: "run" },
    el("span", { class: `run-status ${run.status}` }, runText(run)),
    meter(run.total === 0 ? 0 : run.next / run.total),
    el("div", { class: "cost" }, costOf(state.decisions.length)),
  );
}

/**
 * What happened to permission in the rehearsal, in one sentence, so nobody has to piece it
 * together from the ladder, the checklist and the tiles — or mistake its end state for the verdict.
 */
function rehearsalOutcome(state) {
  const promotions = state.events.filter((recorded) => recorded.event.kind === "promoted");
  const trial = promotions.find((recorded) => recorded.event.to === "EARNING");
  const autonomy = promotions.find((recorded) => recorded.event.to === "AUTONOMOUS");
  const revoked = state.events.some((recorded) => recorded.event.kind === "revoked");
  const blocked = state.decisions.filter((decision) => decision.route.to === "block").length;
  const { permission } = state;
  const soFar = state.run.status === "running" ? "So far in this rehearsal, " : "In this rehearsal, ";

  if (!trial) return `${soFar}it never earned permission to act. Every verdict would have gone to a person.`;
  if (!autonomy) {
    return `${soFar}it cleared the bar after ${trial.event.tally.right} correct calls and went on trial, but never finished the trial, so it never acted alone.`;
  }
  const earned = `${soFar}it earned the right to act alone after ${autonomy.event.tally.right} correct calls, and blocked ${plural(blocked, "URL")} on its own.`;
  if (!revoked) return `${earned} It still held that permission at the end.`;
  return (
    `${earned} Then one of its blocks turned out to be wrong, so the block was undone and permission withdrawn. ` +
    `It ended rebuilding from zero: ${permission.right} of ${permission.right + permission.wrong} correct since.`
  );
}

/** What each answer to "does this configuration clear the bar?" means, and what to do about it. */
const QUALIFICATIONS = {
  clears: {
    title: "Clears the bar",
    plain: () => "Proven good enough on these pages.",
    meaning: ({ lower }, bar) =>
      `The worst its precision could plausibly be is ${boundPct(lower, bar)}, at or above the bar. Worth deploying — where it ` +
      "still starts with no permission, and has to earn it again from real reports.",
  },
  not_yet: {
    title: "Not yet",
    plain: (bar) =>
      `Good, but not proven good enough. On these pages its precision can't be shown to reach ${pct(bar)}, and can't be ruled out either.`,
    meaning: ({ lower }) =>
      lower === null
        ? "No phishing call has been judged yet, so there is nothing to measure."
        : "The bar sits inside that range, so these pages can't settle it either way. More labelled pages would.",
  },
  unqualifiable: {
    title: "Unqualifiable",
    plain: (bar) => `Proven not good enough. Its precision can't plausibly reach ${pct(bar)}.`,
    meaning: ({ upper }, bar) =>
      `The best its precision could plausibly be is ${boundPct(upper, bar)}, under the bar. On the evidence so far, this ` +
      "model and prompt will not clear the bar. More pages won't change that — a different model or prompt starts a new record.",
  },
};

/** The result, first: measured precision on the labelled corpus, and whether it clears the bar. */
function resultPanel({ evaluation, policy, run, scope }) {
  const { qualification, phishingCalls: calls, allCalls: all } = evaluation;
  const verdict = QUALIFICATIONS[qualification];
  const n = calls.right + calls.wrong;

  return el(
    "div",
    { class: `result-panel ${qualification}` },
    el(
      "div",
      { class: "result-head" },
      el("span", { class: `qualification ${qualification}` }, verdict.title),
      run.status === "running" ? el("span", { class: "provisional" }, "so far — provisional until every page is scored") : null,
    ),
    el("p", { class: "plain" }, verdict.plain(policy.requiredScore)),
    el(
      "p",
      { class: "muted" },
      "This judges the configuration, not what it's allowed to do. It grants no permission: section 3 rehearses that, " +
        "and the live system, top right, earns its own under Review.",
    ),
    el(
      "div",
      { class: "measured" },
      el("span", { class: "measured-value" }, n === 0 ? "—" : pct(calls.measured)),
      el(
        "span",
        { class: "measured-label" },
        n === 0 ? "measured precision" : `measured precision — ${calls.right} of ${plural(n, "phishing call")} right`,
      ),
    ),
    n === 0 ? null : interval(calls, policy),
    n === 0
      ? null
      : el(
          "p",
          {},
          `Its true precision is plausibly between ${boundPct(calls.lower, policy.requiredScore)} and ${boundPct(calls.upper, policy.requiredScore)}. `,
          `To clear the bar, the lower end must reach ${pct(policy.requiredScore)}.`,
        ),
    el("p", {}, verdict.meaning(calls, policy.requiredScore)),
    el(
      "p",
      { class: "muted" },
      `Across every page: ${all.right} of ${plural(all.judged, "judged verdict")} right, ` +
        `${plural(all.missedPhishing, "phishing page")} missed, ${plural(all.unusable, "unusable answer")}. ` +
        "Only phishing calls count towards the bar: being right that a page is harmless is easy, and counting it would flatter the number.",
    ),
    el(
      "p",
      { class: "scope" },
      `Configuration scored: ${scope.modelId} · prompt ${scope.promptHash.slice(0, 12)} · policy ${scope.policyHash.slice(0, 12)}`,
    ),
  );
}

/**
 * The plausible range drawn against the bar: a band from the lower to the upper bound, the
 * measured value within it, and the bar as a marker. The scale starts low enough to show the
 * whole band, so a wide one isn't cropped into looking narrow.
 */
function interval(calls, policy) {
  const floor = Math.min(0.8, Math.floor(calls.lower * 10) / 10);
  const at = (value) => `${((value - floor) / (1 - floor)) * 100}%`;
  const band = styled(styled(el("div", { class: "meter-fill" }), "left", at(calls.lower)), "right", `calc(100% - ${at(calls.upper)})`);
  const point = styled(el("div", { class: "interval-point" }), "left", at(calls.measured));
  const bar = styled(el("div", { class: "meter-mark" }), "left", at(policy.requiredScore));
  return el(
    "div",
    { class: "interval", "aria-hidden": "true" },
    el("div", { class: "meter" }, band, bar, point),
    el("div", { class: "interval-scale" }, el("span", {}, pct(floor)), el("span", {}, `bar ${pct(policy.requiredScore)}`), el("span", {}, "100%")),
  );
}

/**
 * Where Warden stands. With no confirmed evidence there is nothing for a tile to report, and
 * a row of dashes reads as a broken status bar — so until there is, it says plainly what is
 * missing and what would change it.
 */
function recordPanel(state) {
  const { permission, policy } = state;
  if (permission.right + permission.wrong > 0) {
    return el(
      "div",
      { class: "record" },
      summaryTiles(state),
      el("p", { class: "record-note" }, "Proven precision is recomputed in your browser from the counts above, using the server's own policy."),
    );
  }

  const classified = state.decisions.length;
  const waiting = state.decisions.filter((decision) => decision.label === null).length;
  const uncountable = state.decisions.filter((decision) => decision.label !== null && !decision.counted).length;
  const needed = correctCallsStillNeeded(0, 0, policy);

  return el(
    "div",
    { class: "standing" },
    el("span", { class: "standing-icon", "aria-hidden": "true" }),
    el(
      "div",
      { class: "standing-text" },
      el("p", {}, "Warden has earned nothing here yet, so everything goes to you."),
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
            el("strong", {}, "phishing"),
            " counts towards it: being right that a page is harmless is easy, and counting it would flatter the numbers.",
          )
        : null,
      el(
        "p",
        { class: "muted" },
        `Starting from nothing, ${needed} confirmed-correct phishing verdicts clear the bar, and ${policy.probationLength} more in a row after that before Warden may act alone. That is the point of the bar.`,
      ),
    ),
  );
}

/** Where the run stands on the same lifecycle the front page explains, lit as it climbs. */
function ladder(state) {
  const stages = [
    ["SHADOW", "shadow", "Recommends only", "Every verdict goes to a person."],
    ["EARNING", "earning", "On trial", "Strong enough, not yet proved."],
    ["AUTONOMOUS", "autonomous", "Acts alone", "Blocks URLs by itself."],
  ];
  const reached = new Set(["SHADOW"]);
  for (const recorded of state.events) {
    if (recorded.event.kind === "promoted") reached.add(recorded.event.to);
  }

  return el(
    "ol",
    { class: "lifecycle live", "aria-label": "Where the rehearsal stands" },
    stages.flatMap(([key, css, name, note], index) => {
      const classes = ["stage", css];
      if (reached.has(key)) classes.push("been");
      if (state.permission.state === key) classes.push("here");
      const stage = el(
        "li",
        { class: classes.join(" ") },
        el("div", { class: "stage-name" }, el("span", { class: "stage-dot", "aria-hidden": "true" }), name),
        el("div", { class: "stage-note" }, state.permission.state === key ? hereNote(state) : note),
      );
      if (index === stages.length - 1) return [stage];
      return [
        stage,
        el(
          "li",
          { class: "step-arrow" },
          el("span", { class: "step-label" }, index === 0 ? "73 reviewed, none wrong" : "10 more in a row"),
          el("span", { class: "step-line", "aria-hidden": "true" }),
        ),
      ];
    }),
  );
}

/** The marker on the stage it stands on, saying so when that stage is as high as the evidence allows. */
function hereNote(state) {
  if (standingOf(state) !== "UNQUALIFIABLE") return "← it is here now";
  return "← it is here, and on this evidence the bar is out of reach";
}

/** The standing the engine reported, falling back to the stored state for an older server. */
function standingOf(state) {
  return state.standing ?? state.permission.state;
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
    [
      state.permission.right > 0,
      // The record when the bar was cleared, not the record now: this line sits above beats
      // that happened at 73 and 83, and the current count reads as though it was enough.
      promotions.length > 0
        ? `Built a record — ${promotions[0].event.tally.right} confirmed-correct calls before anything changed`
        : `Building a record — ${state.permission.right} confirmed-correct so far`,
    ],
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

/** The permission at a glance, in plain language, with the bound recomputed from its counts. */
function summaryTiles(record) {
  const { permission, policy, blocklist } = record;
  const n = permission.right + permission.wrong;
  const bound = wilson(permission.right, n, policy.z);
  const stillNeeded = correctCallsStillNeeded(permission.right, permission.wrong, policy);
  const shown = standingOf(record);
  const state = STATES[shown];
  const attempt =
    permission.epoch > 1 ? `attempt ${permission.epoch} — permission has been revoked ${permission.epoch - 1}×` : "first attempt";
  const onTrial = permission.state === "EARNING";

  return el(
    "div",
    { class: "tiles" },
    tile("Can it act alone?", el("span", { class: `state ${shown}`, title: state.detail }, state.label), attempt),
    tile(
      // After a revocation the record restarts, so this is no longer the whole-run figure;
      // say so, or it reads as contradicting the configuration's score.
      permission.epoch > 1 ? "Precision proven this attempt" : "Precision we can prove",
      boundPct(bound, policy.requiredScore),
      permission.epoch > 1
        ? `from ${permission.right} of ${n} since the revocation · needs ${pct(policy.requiredScore)} · the worst plausible, not the average`
        : `needs ${pct(policy.requiredScore)} — the worst its true precision could plausibly be, not its average`,
      meter(bound ?? 0, policy.requiredScore),
    ),
    tile("Confirmed correct", `${permission.right} of ${n}`, `${permission.wrong} wrong since the last reset`),
    stillNeededTile(shown, permission.right, stillNeeded),
    tile(
      "Trial progress",
      onTrial ? `${permission.probation} of ${policy.probationLength}` : "—",
      "correct in a row before it may act alone",
      onTrial ? slots(permission.probation, policy.probationLength) : null,
      { dim: !onTrial },
    ),
    tile(
      "Blocks awaiting review",
      `${permission.unreviewed} of ${policy.maxUnreviewed}`,
      `${plural(blocklist.length, "URL")} blocked right now`,
      slots(permission.unreviewed, policy.maxUnreviewed),
    ),
  );
}

/** `total` small boxes, the first `filled` of them lit. */
function slots(filled, total) {
  return el(
    "div",
    { class: "slots", "aria-hidden": "true" },
    Array.from({ length: total }, (_, i) => el("span", { class: i < filled ? "on" : "" })),
  );
}

/**
 * How far the bar is, with a tick for every correct call it takes: the ones made so far lit,
 * the ones still needed not. For a record that can't qualify, a count would be true only of an
 * unbroken run of correct calls from here — so it says the bar is out of reach instead.
 */
function stillNeededTile(shown, right, stillNeeded) {
  if (shown === "UNQUALIFIABLE") {
    return tile("Still needed", "out of reach", "the best its precision could plausibly be is under the bar");
  }
  if (shown !== "SHADOW" || stillNeeded === null) {
    return tile("Still needed", "none", "correct calls before it could be trusted to act", null, { dim: true });
  }
  const total = Math.min(right + stillNeeded, 200);
  const ticks = el(
    "div",
    { class: "ticks", "aria-hidden": "true" },
    Array.from({ length: total }, (_, i) => el("span", { class: i < right ? "on" : "" })),
  );
  return tile("Still needed", `${stillNeeded} more`, "correct calls before it could be trusted to act", ticks);
}

/** Promotions, revocations and reversals, each linking to the decision that caused it. */
function eventList(events, urlOf, container, hasDecisions, bar) {
  if (events.length === 0) {
    return el(
      "p",
      { class: "empty" },
      hasDecisions
        ? "Warden's permission hasn't moved yet. Only a confirmed judgement changes it, so confirm a verdict below and this fills in."
        : "Nothing yet. This fills in as Warden gains or loses permission.",
    );
  }
  return el(
    "ul",
    { class: "events" },
    events.map((recorded) => {
      const [headline, receipt] = describe(recorded, urlOf, bar);
      return el(
        "li",
        { class: recorded.event.kind },
        el("span", { class: "event-kind" }, KINDS[recorded.event.kind] ?? recorded.event.kind),
        el(
          "div",
          { class: "event-body" },
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
        ),
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
  if (decisions.length === 0) {
    return el("div", { class: "section" }, el("h3", {}, "Decisions"), el("p", { class: "empty" }, "Nothing classified yet."));
  }

  const showing =
    view === "campaigns"
      ? new Set(decisions.map((d) => pageOf(d.url)?.campaign ?? "unknown")).size
      : (view === "mattered" ? decisions.filter(mattered) : decisions.slice(-120)).length;
  const label =
    view === "campaigns"
      ? `Decisions — ${plural(showing, "campaign")}, ${plural(decisions.length, "page")}`
      : `Decisions — showing ${showing} of ${decisions.length}`;
  const heading = el(
    "div",
    { class: "feed-head" },
    el("h3", {}, label),
    el(
      "div",
      { class: "views", role: "group", "aria-label": "How much to show" },
      viewButton("campaigns", "By campaign", view, container),
      viewButton("mattered", "What mattered", view, container),
      viewButton("all", "Everything", view, container),
    ),
  );
  const caption = el("p", { class: "note" }, captionFor(view, state));
  return el("div", { class: "section" }, heading, caption, feedBody(decisions, view, container, onLabel));
}

/** The table for the chosen view. */
function feedBody(decisions, view, container, onLabel) {
  if (view === "campaigns") return campaignTable(decisions);
  if (view === "all") return decisionTable(decisions.slice(-120).reverse(), onLabel);
  const notable = decisions.filter(mattered);
  if (notable.length === 0) return el("p", { class: "empty" }, "Nothing unexpected happened — every call went as intended.");
  return matteredTable(notable, container);
}

/** Explains what the current view shows, and where these pages came from. */
function captionFor(view, state) {
  const built = corpus.summary
    ? `These are ${corpus.summary.pages} pages written for this project — ${corpus.summary.techniques} hand-written techniques, expanded into ${corpus.summary.campaigns} campaigns of near-identical pages on different domains, the way a real phishing kit is deployed across many hosts. None is a copy of a real page.`
    : "";
  if (view === "campaigns") {
    return `${built} Grouped by campaign: siblings share a technique and nearly always go the same way, so a campaign is closer to one piece of evidence than to many.`;
  }
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
      "aria-pressed": id === current ? "true" : "false",
      onclick: () => {
        views.set(container.id, id);
        container.dispatchEvent(new CustomEvent("rerender"));
      },
    },
    label,
  );
}

/** A table in the feed's frame, scrolling sideways on its own when the screen is narrow. */
function feedTable(headings, rows, kind = "") {
  const head = el("thead", {}, el("tr", {}, headings.map((t) => el("th", {}, t))));
  return el("div", { class: "feed" }, el("table", { class: kind }, head, el("tbody", {}, rows)));
}

/**
 * What mattered, with repetition collapsed. Six identical "assembled at runtime · cap full ·
 * correct" rows are one fact stated six times; a reviewer should see the fact and its count.
 */
function matteredTable(notable, container) {
  const groups = new Map();
  for (const decision of notable) {
    const page = pageOf(decision.url);
    const outcome = outcomeOf(decision);
    const key = `${page?.campaign ?? "unknown"}|${outcome}`;
    const group = groups.get(key) ?? {
      technique: page?.technique ?? decision.url,
      truth: page?.truth ?? null,
      outcome,
      route: decision.route,
      count: 0,
      first: decision,
    };
    group.count++;
    groups.set(key, group);
  }

  const rows = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((group) =>
      el(
        "tr",
        {},
        el("td", {}, el("div", { class: "technique" }, group.technique), truthMark(group.truth)),
        el("td", {}, checkBadge(group.route), el("div", { class: "claims" }, group.outcome)),
        el(
          "td",
          { class: "num" },
          el(
            "button",
            {
              type: "button",
              class: "event-link",
              title: "Show one of these in the full list",
              onclick: () => revealDecision(container, group.first.id),
            },
            `${group.count}×`,
          ),
        ),
      ),
    );
  return feedTable(["Page", "Outcome", "Times"], rows);
}

/** How a decision ended, in the words a reviewer would use to describe it. */
function outcomeOf(decision) {
  if (!decision.valid) return `answer rejected: ${decision.rejection}`;
  if (decision.block === "reversed") return "blocked, then undone as wrong";
  if (decision.label === "wrong") return "verdict was wrong";
  if (decision.verdict === "uncertain") return "model would not commit";
  return decision.label === "right" ? "verdict was correct" : "awaiting judgement";
}

/** One row per campaign: the padding collapsed into counts. */
function campaignTable(decisions) {
  const families = new Map();
  for (const decision of decisions) {
    const page = pageOf(decision.url);
    const key = page?.campaign ?? "unknown";
    const family = families.get(key) ?? {
      key,
      technique: page?.technique ?? "—",
      truth: page?.truth ?? null,
      pages: 0,
      right: 0,
      wrong: 0,
      blocked: 0,
      unusable: 0,
    };
    family.pages++;
    if (decision.label === "right") family.right++;
    if (decision.label === "wrong") family.wrong++;
    if (decision.route.to === "block") family.blocked++;
    if (!decision.valid || decision.verdict === "uncertain") family.unusable++;
    families.set(key, family);
  }

  const rows = [...families.values()].map((family) =>
    el(
      "tr",
      {},
      el("td", { class: "url" }, family.key),
      // What the pages really are, so a wrong call reads as a miss or a false alarm at a glance.
      el("td", {}, el("div", { class: "technique" }, family.technique), truthMark(family.truth)),
      el("td", { class: "num" }, String(family.pages)),
      el("td", { class: "num label-right" }, String(family.right)),
      el("td", { class: family.wrong > 0 ? "num label-wrong" : "num muted" }, String(family.wrong)),
      el("td", { class: "num" }, String(family.blocked)),
      el("td", { class: "num muted" }, String(family.unusable)),
    ),
  );
  return feedTable(["Campaign", "Technique", "Pages", "Correct", "Wrong", "Blocked", "Unusable"], rows);
}

/** The decision table, newest first. */
function decisionTable(shown, onLabel) {
  return feedTable(
    ["Page", "Verdict", "Evidence cited", "Outcome", "Block", "Confirmed"],
    shown.map((decision) => feedRow(decision, onLabel)),
    "decisions",
  );
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
  const page = pageOf(decision.url);
  const url = el("div", { class: page ? "url secondary" : "url", title: decision.url }, decision.url);
  if (!page) return url;
  return [el("div", { class: "technique" }, page.technique), truthMark(page.truth), url];
}

/** What a test page really is, or nothing for a page outside the corpus. */
function truthMark(truth) {
  if (!truth) return null;
  if (truth === "phishing") return el("span", { class: "truth-phishing" }, "really phishing");
  return el("span", { class: "truth-legitimate" }, "really legitimate");
}

/** The verdict, with the model's own stated confidence shown as just that. */
function verdictCell(decision) {
  const verdict = el("span", { class: `verdict-${decision.verdict}` }, decision.verdict.replace("_", " "));
  if (decision.confidence === null) return verdict;
  const stated = el(
    "span",
    { class: "claims", title: "The model's own stated confidence. Recorded, but it decides nothing." },
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

/** The confirmed answer, or the buttons to give one. */
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
    { class: "judge" },
    el("button", { type: "button", class: "secondary", onclick: () => onLabel(decision.id, "right") }, "Correct"),
    el("button", { type: "button", class: "secondary", onclick: () => onLabel(decision.id, "wrong") }, "Wrong"),
    decision.counted ? null : el("span", { class: "muted", title: "Only a verdict of phishing counts towards the record." }, "won't move the record"),
  );
}

// Scoring a configuration. The API still calls these demo runs: the mechanism underneath is
// unchanged, and only what the screen says about it is.
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
  if (lastDemoState) renderEvaluation($("demo"), lastDemoState);
});

// The run on screen, whose id the Score tab and the address bar carry.
let watchingRunId = null;

/** Puts the run being watched in the address bar, when the Score page is the one showing. */
function runInAddress(runId) {
  if (!window.location.hash.startsWith("#score")) return;
  const wanted = runId ? `#score/${runId}` : "#score";
  if (window.location.hash !== wanted) history.replaceState(null, "", wanted);
}

/** Shows a scoring run and keeps polling it while it runs. */
async function watchDemo(runId) {
  clearTimeout(demoTimer);
  watchingRunId = runId;
  store(RUN_KEY, runId);
  runInAddress(runId);
  const res = await api("GET", `/demo/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return demoUnavailable(res);
  // A run that never started has nothing to score; there is nothing to show but the button.
  if (!res.data.run) return demoUnavailable({ status: 404, data: { message: "That run never started." } });

  lastDemoState = { ...res.data, run: { ...res.data.run, runId } };
  renderEvaluation($("demo"), lastDemoState);
  const running = res.data.run.status === "running";
  $("run-demo").disabled = running;
  $("run-demo").textContent = running ? "Scoring…" : "Score it again";
  $("clear-demo").hidden = running;
  if (running) demoTimer = setTimeout(() => watchDemo(runId), 1500);
}

/** Explains why a scoring run can't be shown, and forgets a run the server doesn't know. */
function demoUnavailable(res) {
  $("demo").replaceChildren(el("p", { class: "error" }, explain(res)));
  $("run-demo").disabled = false;
  if (res.status !== 404) return;
  store(RUN_KEY, "");
  watchingRunId = null;
}

$("run-demo").addEventListener("click", async () => {
  $("run-demo").disabled = true;
  const res = await api("POST", "/demo/runs");
  if (!res.ok) return demoUnavailable(res);
  // A new entry in the history, so Back returns to the previous run.
  window.location.hash = `#score/${res.data.runId}`;
});

// Each scoring run already gets its own ledger, so running again is the reset. Clearing only
// stops showing the old one, and costs nothing.
$("clear-demo").addEventListener("click", () => {
  store(RUN_KEY, "");
  watchingRunId = null;
  runInAddress(null);
  lastDemoState = null;
  clearTimeout(demoTimer);
  $("demo").replaceChildren(emptyScore());
  $("clear-demo").hidden = true;
  $("run-demo").textContent = "Score it";
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
  showLiveStatus(res.data);
  const waiting = res.data.decisions.filter((decision) => decision.label === null).length;
  $("queue-count").textContent = waiting === 0 ? "" : String(waiting);
  renderLedger($("live"), res.data, { onLabel: labelLive });
}

/**
 * What the live system is allowed to do, in the masthead, colour-coded and on every page.
 * It is the one fact a viewer should never have to go looking for.
 */
function showLiveStatus(record) {
  const { permission } = record;
  const shown = standingOf(record);
  const state = STATES[shown];
  $("live-status-mode").textContent = state.label;
  $("live-status-dot").className = `live-dot ${shown}`;
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

// Sending Warden a page.

/** Fills the picker with one page per technique, so nobody has to invent HTML. */
function fillPicker() {
  const picker = $("try-pick");
  if (!picker || corpus.techniques.length === 0) return;
  picker.append(...corpus.techniques.map((page) => el("option", { value: page.id }, `${page.technique} — really ${page.truth}`)));
}

$("try-pick").addEventListener("change", (event) => {
  const chosen = corpus.techniques.find((page) => page.id === event.target.value);
  if (!chosen) return;
  // A real URL on this Worker, so Warden fetches it like any other page rather than being
  // handed source. Served as plain text, so nothing renders a page that imitates phishing.
  $("try-url").value = new URL(`/corpus/pages/${encodeURIComponent(chosen.id)}/source`, window.location.origin).toString();
  $("try-html").value = "";
  $("try-result").replaceChildren();
  $("try-mismatch").hidden = true;
});

$("try-html").addEventListener("input", () => {
  const pasted = $("try-html").value.trim() !== "";
  $("try-mismatch").hidden = !pasted;
  if (pasted) {
    $("try-mismatch").textContent =
      "Warden will judge the source below and record it under the URL above, without fetching anything. Clear it to fetch the URL instead.";
  }
});

/** One numbered step of what happened to a page, with a tone for its number. */
function pipelineStep(index, tone, title, ...body) {
  return el(
    "li",
    {},
    el("div", { class: "step-rail" }, el("span", { class: `step-index ${tone}` }, String(index))),
    el("div", { class: "step-content" }, el("div", { class: "step-title" }, title), ...body),
  );
}

/** How the verdict's number is coloured: a phishing call in red, a clean one green, an unsure one amber. */
const VERDICT_TONES = { phishing: "bad", not_phishing: "good", uncertain: "warn" };

/** What happened to a page, step by step, so the flow is visible rather than implied. */
function renderClassification(d, url) {
  const excerpt = d.excerpt.length > 300 ? `${d.excerpt.slice(0, 300)}…` : d.excerpt;
  const stated = d.confidence === null ? "" : ` — it claims ${Math.round(d.confidence * 100)}% confidence, which decides nothing`;
  const verdict = d.verdict ?? "none";

  return el(
    "div",
    { class: "result-card" },
    el("div", { class: "result-bar" }, el("span", { class: "url", title: url }, url), el("span", { class: `verdict-${verdict}` }, verdict.replace("_", " "))),
    el(
      "ol",
      { class: "pipeline" },
      d.fetched
        ? pipelineStep(0, "", "Warden fetched the page", el("div", { class: "step-body" }, "https only, redirects re-checked at every hop, nothing aimed at a private address"))
        : pipelineStep(0, "", "You supplied the page source", el("div", { class: "step-body" }, "nothing was fetched")),
      pipelineStep(
        1,
        "",
        "Signals extracted from the page",
        el("div", {}, chips(d.signals)),
        el("div", { class: "step-body" }, `plus ${d.excerpt.length} characters of its text, given to the model as data, never as instructions`),
      ),
      pipelineStep(
        2,
        VERDICT_TONES[d.verdict] ?? "",
        "The model gave a verdict",
        el("div", {}, el("span", { class: `verdict-${verdict}` }, verdict.replace("_", " ")), el("span", { class: "muted" }, stated)),
        d.reasoning ? el("div", { class: "reasoning" }, d.reasoning) : null,
      ),
      pipelineStep(
        3,
        d.valid ? "good" : "bad",
        "Its evidence was checked against the page",
        d.valid
          ? el("div", { class: "step-row" }, el("span", { class: "step-body" }, "every signal it cited was really found:"), d.citedSignals.map((id) => el("span", { class: "chip found" }, id)))
          : el("div", { class: "rejected" }, `rejected — ${d.rejection}. It earns nothing and goes to a person.`),
      ),
      pipelineStep(
        4,
        "",
        "Permission was checked",
        el(
          "div",
          { class: "step-row" },
          checkBadge(d.route),
          el("span", { class: "step-body" }, (REASONS[d.route.reason] ?? [])[1] ?? "Warden blocked this URL on its own."),
        ),
      ),
      pipelineStep(
        5,
        "next",
        "Waiting for your judgement",
        el("div", { class: "step-body" }, "Nothing about Warden's record has changed yet. Confirming whether this verdict was right is the only thing that moves it."),
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
          el("span", {}, "under Review, where everything awaiting you is listed"),
        ),
      ),
    ),
    el("div", { class: "excerpt" }, el("div", { class: "excerpt-label" }, "Page text the model saw"), el("div", { class: "excerpt-text" }, excerpt)),
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
  const submit = event.submitter ?? $("try-form").querySelector("button[type=submit]");
  submit.disabled = true;
  const url = $("try-url").value;
  const html = $("try-html").value.trim();
  $("try-result").replaceChildren(
    el("p", { class: "empty" }, html === "" ? "Fetching the page, then classifying — this is a live model call…" : "Classifying — this is a live model call…"),
  );
  const res = await api("POST", "/classify", html === "" ? { url } : { url, html });
  submit.disabled = false;

  if (!res.ok) return $("try-result").replaceChildren(el("p", { class: "error" }, explain(res)));
  $("try-result").replaceChildren(renderClassification(res.data, url));
  loadLive();
});

// Cmd-Enter on a Mac, Ctrl-Enter elsewhere, submits from anywhere on the page — the textarea
// included, where Enter alone has to stay a newline.
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
$("submit-keys").textContent = MAC ? "⌘ ↵" : "Ctrl ↵";

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !(MAC ? event.metaKey : event.ctrlKey)) return;
  if ($("page-try").hidden) return;
  event.preventDefault();
  $("try-form").requestSubmit();
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

/**
 * The address bar names the page, so a refresh or a shared link lands in the same place.
 * The first hash listed for a page is the one its tab sets; "#demo" still works for old links.
 */
const ROUTES = {
  "#how-it-works": "nav-about",
  "#send": "nav-try",
  "#review": "nav-review",
  "#score": "nav-demo",
  "#demo": "nav-demo",
};

// A scoring run's own address: #score/<run id>.
const RUN_ROUTE = /^#score\/([0-9a-f-]{36})$/i;

/** Shows the page the address bar names, or How it works for anything it doesn't; a run's address also opens that run. */
function routeFromHash() {
  const run = RUN_ROUTE.exec(window.location.hash);
  if (!run) {
    showPage(ROUTES[window.location.hash] ?? "nav-about");
    runInAddress(watchingRunId);
    return;
  }
  showPage("nav-demo");
  if (run[1] !== watchingRunId) watchDemo(run[1]);
}

for (const [nav] of PAGES) {
  const hash = Object.keys(ROUTES).find((key) => ROUTES[key] === nav);
  $(nav).addEventListener("click", () => {
    // The Score tab goes back to the run on screen, not to an empty page.
    window.location.hash = nav === "nav-demo" && watchingRunId ? `#score/${watchingRunId}` : hash;
  });
}

$("demo").replaceChildren(emptyScore());
window.addEventListener("hashchange", routeFromHash);
routeFromHash();

loadCorpus();
loadLive();
setInterval(loadLive, 15_000);
// No run in the address: reopen the last one this browser watched, if any.
const lastRun = stored(RUN_KEY);
if (!watchingRunId && lastRun) watchDemo(lastRun);
