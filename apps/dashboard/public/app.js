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

/** Shows a message across the top of the page; an empty message hides it. */
function showBanner(text) {
  const banner = $("banner");
  banner.textContent = text;
  banner.hidden = !text;
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

/** How many more clean labels it takes for the bound to clear the bar. */
function cleanLabelsToClear(right, wrong, policy) {
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

const REASONS = {
  shadow: "SHADOW, so it only recommends",
  earning: "EARNING, so it's on probation",
  cap_full: "the cap is full: blocks await review",
  stale_epoch: "stale: decided before a revocation",
  rejected: "the response was rejected",
  not_phishing: "the verdict was not phishing",
  uncertain: "the verdict was uncertain",
  duplicate: "the page was already decided",
};

/** What the permission check did with a decision, in words. */
function routeText(route) {
  if (route.to === "block") return "blocked automatically";
  return `to a person: ${REASONS[route.reason] ?? route.reason}`;
}

/** One summary tile. */
function tile(label, value, sub, extra) {
  return el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), sub ? el("div", { class: "sub" }, sub) : null, extra ?? null);
}

/** The numbers an event was decided on. */
function tally(t) {
  return `${t.right} right of ${t.right + t.wrong} · lower bound ${pct(t.bound)} · epoch ${t.epoch}`;
}

/** An event as a headline and the receipt behind it. */
function describe(recorded, urlOf) {
  const { event } = recorded;
  switch (event.kind) {
    case "promoted":
      return [`Promoted ${event.from} → ${event.to}`, tally(event.tally)];
    case "demoted":
      return [`Dropped ${event.from} → SHADOW. Same epoch, nothing reversed.`, tally(event.tally)];
    case "probation_restarted":
      return ["Probation restarted after a mistake; the bar still holds.", tally(event.tally)];
    case "revoked":
      return [`Permission revoked: epoch ${event.tally.epoch} → ${event.nextEpoch}, counters reset.`, `record when revoked: ${tally(event.tally)}`];
    case "reversed":
      return [`Block reversed: ${urlOf(recorded.decisionId)}`, `authorised in epoch ${event.blockEpoch}`];
    default:
      return [event.kind, ""];
  }
}

/** A demo run's progress in words. */
function runText(run) {
  if (run.status === "running") return `Running: page ${run.next} of ${run.total}`;
  if (run.status === "done") return `Done: all ${run.total} pages decided`;
  return `Stopped after ${run.next} of ${run.total} pages: ${run.reason}`;
}

/** Renders a ledger: run progress, summary tiles, events and the decision feed. */
function renderLedger(container, state, { onLabel } = {}) {
  const urls = new Map(state.decisions.map((decision) => [decision.id, decision.url]));
  container.replaceChildren(
    ...(state.run ? [runProgress(state.run)] : []),
    summaryTiles(state),
    el("p", { class: "hint" }, "The lower bound is recomputed in your browser from the counts above, with the server's policy."),
    el("h3", {}, "What changed, and why"),
    eventList(state.events, (id) => urls.get(id) ?? "an unknown URL"),
    ...decisionFeed(state.decisions, onLabel),
  );
}

/** A demo run's status line and progress bar. */
function runProgress(run) {
  return el("div", { class: "run" }, el("span", { class: `status ${run.status}` }, runText(run)), el("progress", { value: run.next, max: run.total }));
}

/** The permission at a glance, with the bound recomputed from its counts. */
function summaryTiles({ permission, policy, blocklist }) {
  const n = permission.right + permission.wrong;
  const bound = wilson(permission.right, n, policy.z);
  const toClear = cleanLabelsToClear(permission.right, permission.wrong, policy);
  const blocked = `${blocklist.length} URL${blocklist.length === 1 ? "" : "s"} blocked now`;
  return el(
    "div",
    { class: "tiles" },
    tile("Permission", el("span", { class: `state ${permission.state}` }, permission.state), `epoch ${permission.epoch}`),
    tile("Lower bound", pct(bound), `bar ${pct(policy.requiredScore)} · z = ${policy.z}`, el("progress", { value: bound ?? 0, max: 1 })),
    tile("Track record", `${permission.right} / ${n}`, `${permission.wrong} wrong this epoch`),
    tile("To clear the bar", permission.state === "SHADOW" && toClear !== null ? `${toClear} more` : "cleared", "clean labels needed"),
    tile("Probation", permission.state === "EARNING" ? `${permission.probation} / ${policy.probationLength}` : "—", "correct checks in a row"),
    tile("Unreviewed blocks", `${permission.unreviewed} / ${policy.maxUnreviewed}`, blocked),
  );
}

/** Promotions, demotions, revocations and reversals, each with its receipt. */
function eventList(events, urlOf) {
  if (events.length === 0) return el("p", { class: "empty" }, "No promotions, revocations or reversals yet.");
  return el(
    "ul",
    { class: "events" },
    events.map((recorded) => {
      const [headline, receipt] = describe(recorded, urlOf);
      return el("li", { class: recorded.event.kind }, headline, el("span", { class: "receipt" }, receipt));
    }),
  );
}

/** The decision feed's heading and table, newest first. */
function decisionFeed(decisions, onLabel) {
  const shown = decisions.slice(-80).reverse();
  const more = decisions.length > shown.length ? ` (latest ${shown.length} of ${decisions.length})` : "";
  const heading = el("h3", {}, `Decisions${more}`);
  if (shown.length === 0) return [heading, el("p", { class: "empty" }, "Nothing decided yet.")];

  const head = el("thead", {}, el("tr", {}, ["URL", "Verdict", "Evidence", "Permission check", "Block", "Label"].map((title) => el("th", {}, title))));
  const body = el("tbody", {}, shown.map((decision) => feedRow(decision, onLabel)));
  return [heading, el("div", { class: "feed" }, el("table", {}, head, body))];
}

/** One decision: what the model said, what it cited, what the permission check did, and how it was labelled. */
function feedRow(decision, onLabel) {
  return el(
    "tr",
    {},
    el("td", { class: "url", title: decision.url }, decision.url),
    el("td", {}, verdictCell(decision)),
    el("td", {}, evidenceCell(decision)),
    el("td", {}, decision.route.to === "block" ? el("span", { class: "blocked" }, routeText(decision.route)) : routeText(decision.route)),
    el("td", {}, blockCell(decision)),
    el("td", {}, labelCell(decision, onLabel)),
  );
}

/** The verdict, with the model's own stated confidence shown as just that. */
function verdictCell(decision) {
  const verdict = el("span", { class: `verdict-${decision.verdict}` }, decision.verdict.replace("_", " "));
  if (decision.confidence === null) return verdict;
  const stated = el("div", { class: "muted", title: "As the model stated it. Recorded, never used to decide anything." }, `says ${Math.round(decision.confidence * 100)}%`);
  return [verdict, stated];
}

/** The signals a verdict cited, or why its response was rejected. */
function evidenceCell(decision) {
  if (!decision.valid) return el("span", { class: "rejected" }, `rejected: ${decision.rejection}`);
  if (decision.citedSignals.length === 0) return el("span", { class: "muted" }, "none cited");
  return decision.citedSignals.map((id) => el("span", { class: "chip" }, id));
}

/** Whether the decision's block still stands. */
function blockCell(decision) {
  if (!decision.block) return el("span", { class: "muted" }, "—");
  return el("span", { class: `block-${decision.block}` }, decision.block);
}

/** The label, or buttons to set one where a person may label. */
function labelCell(decision, onLabel) {
  if (decision.label) return el("span", { class: `label-${decision.label}` }, decision.label);
  if (!onLabel) return el("span", { class: "muted" }, "—");
  return el(
    "div",
    { class: "actions" },
    el("button", { type: "button", class: "secondary", title: "The verdict was right", onclick: () => onLabel(decision.id, "right") }, "Right"),
    el("button", { type: "button", class: "secondary", title: "The verdict was wrong", onclick: () => onLabel(decision.id, "wrong") }, "Wrong"),
  );
}

// Demo runs.
let demoTimer;

/** Shows a demo run and keeps polling it while it runs. */
async function watchDemo(runId) {
  clearTimeout(demoTimer);
  const res = await api("GET", `/demo/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return demoUnavailable(res);

  renderLedger($("demo"), res.data);
  const running = res.data.run?.status === "running";
  $("run-demo").disabled = running;
  if (running) demoTimer = setTimeout(() => watchDemo(runId), 1000);
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

/** Loads and shows the live ledger, with label buttons on anything unlabelled. */
async function loadLive() {
  const res = await api("GET", "/live");
  if (!res.ok) return $("live").replaceChildren(el("p", { class: res.status === 503 ? "empty" : "error" }, explain(res)));
  renderLedger($("live"), res.data, { onLabel: labelLive });
}

/** Applies a person's label to a live decision, then reloads the ledger. */
async function labelLive(decisionId, label) {
  const res = await api("POST", "/live/labels", { decisionId, label });
  showBanner(res.ok ? "" : explain(res));
  loadLive();
}

$("refresh-live").addEventListener("click", loadLive);

// Try it live.

/** A definition-list row. */
function row(term, ...definition) {
  return [el("dt", {}, term), el("dd", {}, ...definition)];
}

/** Shows what came back from classifying a pasted page. */
function renderClassification(d) {
  const excerpt = d.excerpt.length > 400 ? `${d.excerpt.slice(0, 400)}…` : d.excerpt;
  const stated = d.confidence === null ? "" : ` (the model says ${Math.round(d.confidence * 100)}%)`;
  return el(
    "div",
    { class: "result" },
    el(
      "dl",
      {},
      row("Verdict", el("span", { class: `verdict-${d.verdict ?? "none"}` }, d.verdict ?? "none"), stated),
      row("Validation", d.valid ? "passed" : el("span", { class: "rejected" }, `rejected: ${d.rejection}`)),
      row("Evidence cited", chips(d.citedSignals.map((id) => ({ id })))),
      row("Permission check", routeText(d.route)),
      row("Reasoning", d.reasoning ?? el("span", { class: "muted" }, "none")),
      row("Signals found", chips(d.signals)),
      row("Page text seen", el("span", { class: "muted" }, excerpt)),
    ),
  );
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
  const res = await api("POST", "/classify", { url: $("try-url").value, html: $("try-html").value });
  submit.disabled = false;

  if (!res.ok) return $("try-result").replaceChildren(el("p", { class: "error" }, explain(res)));
  $("try-result").replaceChildren(renderClassification(res.data));
  loadLive();
});

loadLive();
setInterval(loadLive, 10_000);
const lastRun = stored(RUN_KEY);
if (lastRun) watchDemo(lastRun);
