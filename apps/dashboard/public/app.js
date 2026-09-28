// Warden's dashboard.
//
// Much of what it shows was written by whoever controls a reported page, so it is only ever
// inserted as text, never as markup, and no link is ever built from a page's URL.

const $ = (id) => document.getElementById(id);

/** Builds an element. Strings become text nodes, never markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// The token lives in this tab only, and the page still works when storage is blocked.
const TOKEN_KEY = "warden-token";
const RUN_KEY = "warden-demo-run";
const stored = (key) => {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const store = (key, value) => {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage is a convenience here; without it the token just isn't remembered.
  }
};
let token = stored(TOKEN_KEY);

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, status: 0, data: { error: "network", message: `Couldn't reach the server: ${error}` } };
  }
}

function explain(res) {
  if (res.status === 401) return "That needs the access token (top right).";
  return res.data?.message ?? `The server answered ${res.status}.`;
}

function showBanner(text) {
  const banner = $("banner");
  banner.textContent = text;
  banner.hidden = !text;
}

// The bound is recomputed here, in the browser, from the ledger's own counts and the
// server's own policy: the arithmetic that grants permission is something anyone can check.
function wilson(right, n, z) {
  if (n === 0) return null;
  const p = right / n;
  const z2 = z * z;
  const lower = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return Math.min(1, Math.max(0, lower));
}

function cleanLabelsToClear(right, wrong, policy) {
  for (let more = 0; more <= 10_000; more++) {
    const bound = wilson(right + more, right + wrong + more, policy.z);
    if (bound !== null && bound >= policy.requiredScore) return more;
  }
  return null;
}

const pct = (value) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);

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

function tile(label, value, sub, extra) {
  return el("div", { class: "tile" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), sub ? el("div", { class: "sub" }, sub) : null, extra ?? null);
}

function tally(t) {
  return `${t.right} right of ${t.right + t.wrong} · lower bound ${pct(t.bound)} · epoch ${t.epoch}`;
}

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

function renderLedger(container, state, { onLabel } = {}) {
  const { permission, policy } = state;
  const n = permission.right + permission.wrong;
  const bound = wilson(permission.right, n, policy.z);
  const toClear = cleanLabelsToClear(permission.right, permission.wrong, policy);
  const urls = new Map(state.decisions.map((decision) => [decision.id, decision.url]));

  const parts = [];

  if (state.run) {
    const { status, next, total, reason } = state.run;
    const text =
      status === "running" ? `Running: page ${next} of ${total}` : status === "done" ? `Done: all ${total} pages decided` : `Stopped after ${next} of ${total} pages: ${reason}`;
    parts.push(el("div", { class: "run" }, el("span", { class: `status ${status}` }, text), el("progress", { value: next, max: total })));
  }

  parts.push(
    el(
      "div",
      { class: "tiles" },
      tile("Permission", el("span", { class: `state ${permission.state}` }, permission.state), `epoch ${permission.epoch}`),
      tile("Lower bound", pct(bound), `bar ${pct(policy.requiredScore)} · z = ${policy.z}`, el("progress", { value: bound ?? 0, max: 1 })),
      tile("Track record", `${permission.right} / ${n}`, `${permission.wrong} wrong this epoch`),
      tile("To clear the bar", permission.state === "SHADOW" && toClear !== null ? `${toClear} more` : "cleared", "clean labels needed"),
      tile("Probation", permission.state === "EARNING" ? `${permission.probation} / ${policy.probationLength}` : "—", "correct checks in a row"),
      tile("Unreviewed blocks", `${permission.unreviewed} / ${policy.maxUnreviewed}`, `${state.blocklist.length} URL${state.blocklist.length === 1 ? "" : "s"} blocked now`),
    ),
  );
  parts.push(el("p", { class: "hint" }, "The lower bound is recomputed in your browser from the counts above, with the server's policy."));

  parts.push(el("h3", {}, "What changed, and why"));
  if (state.events.length === 0) parts.push(el("p", { class: "empty" }, "No promotions, revocations or reversals yet."));
  else
    parts.push(
      el(
        "ul",
        { class: "events" },
        state.events.map((recorded) => {
          const [headline, receipt] = describe(recorded, (id) => urls.get(id) ?? "an unknown URL");
          return el("li", { class: recorded.event.kind }, headline, el("span", { class: "receipt" }, receipt));
        }),
      ),
    );

  const shown = state.decisions.slice(-80).reverse();
  parts.push(el("h3", {}, `Decisions${state.decisions.length > shown.length ? ` (latest ${shown.length} of ${state.decisions.length})` : ""}`));
  if (shown.length === 0) parts.push(el("p", { class: "empty" }, "Nothing decided yet."));
  else
    parts.push(
      el(
        "div",
        { class: "feed" },
        el(
          "table",
          {},
          el("thead", {}, el("tr", {}, ["URL", "Verdict", "Evidence", "Permission check", "Block", "Label"].map((heading) => el("th", {}, heading)))),
          el("tbody", {}, shown.map((decision) => feedRow(decision, onLabel))),
        ),
      ),
    );

  container.replaceChildren(...parts);
}

function feedRow(decision, onLabel) {
  const verdict = el(
    "td",
    {},
    el("span", { class: `verdict-${decision.verdict}` }, decision.verdict.replace("_", " ")),
    decision.confidence !== null ? el("div", { class: "muted", title: "As the model stated it. Recorded, never used to decide anything." }, `says ${Math.round(decision.confidence * 100)}%`) : null,
  );
  const evidence = decision.valid
    ? decision.citedSignals.length > 0
      ? decision.citedSignals.map((id) => el("span", { class: "chip" }, id))
      : el("span", { class: "muted" }, "none cited")
    : el("span", { class: "rejected" }, `rejected: ${decision.rejection}`);
  const check =
    decision.route.to === "block" ? el("span", { class: "blocked" }, "blocked automatically") : el("span", {}, `to a person: ${REASONS[decision.route.reason] ?? decision.route.reason}`);

  let label;
  if (decision.label) label = el("span", { class: `label-${decision.label}` }, decision.label);
  else if (onLabel)
    label = el(
      "div",
      { class: "actions" },
      el("button", { type: "button", class: "secondary", title: "The verdict was right", onclick: () => onLabel(decision.id, "right") }, "Right"),
      el("button", { type: "button", class: "secondary", title: "The verdict was wrong", onclick: () => onLabel(decision.id, "wrong") }, "Wrong"),
    );
  else label = el("span", { class: "muted" }, "—");

  return el(
    "tr",
    {},
    el("td", { class: "url", title: decision.url }, decision.url),
    verdict,
    el("td", {}, evidence),
    el("td", {}, check),
    el("td", {}, decision.block ? el("span", { class: `block-${decision.block}` }, decision.block) : el("span", { class: "muted" }, "—")),
    el("td", {}, label),
  );
}

// Demo runs.
let demoTimer;

async function watchDemo(runId) {
  clearTimeout(demoTimer);
  const res = await api("GET", `/demo/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) {
    $("demo").replaceChildren(el("p", { class: "error" }, explain(res)));
    $("run-demo").disabled = false;
    if (res.status === 404) store(RUN_KEY, "");
    return;
  }
  renderLedger($("demo"), res.data);
  const running = res.data.run?.status === "running";
  $("run-demo").disabled = running;
  if (running) demoTimer = setTimeout(() => watchDemo(runId), 1000);
}

$("run-demo").addEventListener("click", async () => {
  $("run-demo").disabled = true;
  const res = await api("POST", "/demo/runs");
  if (!res.ok) {
    $("demo").replaceChildren(el("p", { class: "error" }, explain(res)));
    $("run-demo").disabled = false;
    return;
  }
  store(RUN_KEY, res.data.runId);
  watchDemo(res.data.runId);
});

// The live ledger.
async function loadLive() {
  const res = await api("GET", "/live");
  if (!res.ok) {
    $("live").replaceChildren(el("p", { class: res.status === 503 ? "empty" : "error" }, explain(res)));
    return;
  }
  renderLedger($("live"), res.data, { onLabel: labelLive });
}

async function labelLive(decisionId, label) {
  const res = await api("POST", "/live/labels", { decisionId, label });
  showBanner(res.ok ? "" : explain(res));
  loadLive();
}

$("refresh-live").addEventListener("click", loadLive);

// Try it live.
$("try-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter ?? $("try-form").querySelector("button");
  submit.disabled = true;
  const res = await api("POST", "/classify", { url: $("try-url").value, html: $("try-html").value });
  submit.disabled = false;

  if (!res.ok) {
    $("try-result").replaceChildren(el("p", { class: "error" }, explain(res)));
    return;
  }
  const d = res.data;
  const row = (term, ...definition) => [el("dt", {}, term), el("dd", {}, ...definition)];
  $("try-result").replaceChildren(
    el(
      "div",
      { class: "result" },
      el(
        "dl",
        {},
        row("Verdict", el("span", { class: `verdict-${d.verdict ?? "none"}` }, d.verdict ?? "none"), d.confidence !== null ? ` (the model says ${Math.round(d.confidence * 100)}%)` : ""),
        row("Validation", d.valid ? "passed" : el("span", { class: "rejected" }, `rejected: ${d.rejection}`)),
        row("Evidence cited", d.citedSignals.length > 0 ? d.citedSignals.map((id) => el("span", { class: "chip" }, id)) : el("span", { class: "muted" }, "none")),
        row("Permission check", d.route.to === "block" ? "blocked automatically" : `to a person: ${REASONS[d.route.reason] ?? d.route.reason}`),
        row("Reasoning", d.reasoning ?? el("span", { class: "muted" }, "none")),
        row("Signals found", d.signals.length > 0 ? d.signals.map((s) => el("span", { class: "chip", title: s.detail }, s.id)) : el("span", { class: "muted" }, "none")),
        row("Page text seen", el("span", { class: "muted" }, d.excerpt.length > 400 ? `${d.excerpt.slice(0, 400)}…` : d.excerpt)),
      ),
    ),
  );
  loadLive();
});

// The token.
function reflectToken() {
  $("token-state").textContent = token ? "Token set for this tab." : "Viewing is open; anything that spends inference or changes state needs the token.";
}

$("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  token = $("token").value.trim();
  store(TOKEN_KEY, token);
  $("token").value = "";
  reflectToken();
  showBanner("");
});

reflectToken();
loadLive();
setInterval(loadLive, 10_000);
const lastRun = stored(RUN_KEY);
if (lastRun) watchDemo(lastRun);
