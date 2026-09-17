import { evaluate, fmtUSD } from "./tiers.js";
import { research } from "./research.js";
import { GEMINI_API_KEY, GEMINI_MODEL } from "./config.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let facts = null;
let sources = [];

// Key comes from the deployed config. If none was deployed, each visitor can use their own.
// A visitor's own free key (saved in their browser) wins over the shared one,
// so heavy users don't eat the team's free quota.
const builtInKey = GEMINI_API_KEY;
const ownKey = store.get("icp-gemini-key") || "";
if (!builtInKey || ownKey) {
  $("codeRow").classList.remove("hidden");
  $("code").value = ownKey;
}
$("ownKey").addEventListener("click", (e) => {
  e.preventDefault();
  $("codeRow").classList.remove("hidden");
  $("code").focus();
});

const EMPTY = { company: "", last_round_stage: null, last_round_date: null, hq_country: null, employees_min: null, employees_max: null, funding_usd: null, segment: "", segment_fit: true, tiny_operation: false, low_budget: false };
function manual() {
  const url = $("url").value.trim();
  facts = { ...EMPTY, company: url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "Manual entry", website: url || null, notes: "Entered by hand. Fill in country and headcount." };
  sources = [];
  fillFacts(); render();
  document.querySelector('[data-f="hq_country"]').focus();
}
$("manual").addEventListener("click", () => { status(""); manual(); });

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  const notes = $("notes").value.trim();
  if (!url && !notes) return status("Paste a website or some details first.", true);

  $("go").disabled = true;
  const steps = ["Reading the website…", "Searching LinkedIn, Crunchbase and press…", "Checking headcount and funding…", "Almost there…"];
  let i = 0; status(steps[0]);
  var timer = setInterval(() => status(steps[Math.min(++i, steps.length - 1)]), 5000);

  try {
    const key = $("code").value.trim() || builtInKey;
    if (!key) { $("code").focus(); throw new Error("Add a Gemini API key first."); }
    const data = await research({ key, model: GEMINI_MODEL, url, notes, onStatus: (m) => { clearInterval(timer); status(m); } });
    if (!data.searched) sources = [];
    if ($("code").value.trim()) store.set("icp-gemini-key", $("code").value.trim());
    facts = data.facts; sources = data.sources || [];
    if (!data.searched) facts.notes = [facts.notes, "Google Search quota was busy, so this used the website only. Double-check headcount and funding."].filter(Boolean).join(" ");
    fillFacts(); render();
    status("");
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (/quota|rate limit|busy|took too long|reach Gemini/i.test(err.message)) {
      manual();
      status("The free AI lookup is busy right now. Fill in the facts below and the tier appears instantly.", true);
    } else {
      status(err.message, true);
    }
  } finally {
    clearInterval(timer); $("go").disabled = false;
  }
});

document.querySelectorAll("#facts [data-f]").forEach((el) => {
  el.addEventListener("input", () => {
    if (!facts) return;
    const k = el.dataset.f;
    facts[k] = el.type === "checkbox" ? el.checked : el.value === "" ? null : el.value;
    // A hand-picked round replaces the AI's free-text round description.
    if (k === "last_round_stage" || k === "last_round_date") facts.last_round = null;
    render();
  });
});

$("copy").addEventListener("click", async () => {
  const v = evaluate(facts);
  const lines = [
    `${facts.company || "Company"}: Tier ${v.tier || "?"} (${v.label})`,
    v.action,
    ...v.checks.map((c) => `- ${c.param}: ${c.value} (${c.note})`),
    ...v.flags.map((f) => `! ${f}`),
    facts.website ? `Site: ${facts.website}` : "",
  ].filter(Boolean);
  try { await navigator.clipboard.writeText(lines.join("\n")); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Copy failed"; }
  setTimeout(() => ($("copy").textContent = "Copy summary"), 1500);
});

function fillFacts() {
  document.querySelectorAll("#facts [data-f]").forEach((el) => {
    const v = facts[el.dataset.f];
    if (el.type === "checkbox") el.checked = v === true;
    else el.value = v ?? "";
  });
}

function render() {
  const v = evaluate(facts);
  $("result").classList.remove("hidden");
  const badge = $("tierBadge");
  badge.className = "badge " + (v.tier || "");
  badge.textContent = v.tier || "?";
  $("company").textContent = facts.company || "Unknown company";
  $("tierLabel").textContent = v.tier ? `Tier ${v.tier} · ${v.label}` : v.label;
  $("tierAction").textContent = v.action;

  $("flagsCard").classList.toggle("hidden", !v.flags.length);
  $("flags").replaceChildren(...v.flags.map((f) => el("li", f)));

  $("checks").replaceChildren(...v.checks.map((c) => {
    const tr = document.createElement("tr");
    const icon = el("td", c.pass === true ? "✓" : c.pass === false ? "✕" : "?");
    icon.className = c.pass === true ? "ok" : c.pass === false ? "no" : "unk";
    const main = el("td"); main.append(el("div", c.param, "p"), el("div", c.note, "n"));
    tr.append(icon, main, el("td", c.value));
    return tr;
  }));

  const extra = [
    ["What they do", facts.one_liner],
    ["City", facts.hq_city],
    ["Headcount source", facts.employees_source],
    ["Last round", facts.last_round],
    ["Raised", facts.funding_usd ? fmtUSD(facts.funding_usd) : null],
    ["Decision makers", (facts.decision_makers || []).map((d) => `${d.name} (${d.title})`).join(", ")],
    ["Buying triggers", (facts.buying_triggers || []).join(" · ")],
    ["Active social/ads", facts.active_social_or_ads == null ? null : facts.active_social_or_ads ? "Yes" : "No"],
    ["Confidence", facts.confidence],
    ["Double-check", facts.notes],
  ].filter(([, val]) => val);
  $("extra").replaceChildren(...extra.flatMap(([k, val]) => [el("dt", k), el("dd", String(val))]));

  $("sources").replaceChildren(...(sources.length ? sources.map((s) => {
    const li = el("li"); const a = el("a", s.title || s.uri);
    a.href = s.uri; a.target = "_blank"; a.rel = "noopener"; li.append(a); return li;
  }) : [el("li", "No web sources were returned.")]));
}

function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}

function status(msg, err = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("err", err);
}
