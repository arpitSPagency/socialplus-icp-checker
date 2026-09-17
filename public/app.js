import { evaluate, fmtUSD } from "./tiers.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let facts = null;
let sources = [];

const savedCode = store.get("icp-code");
if (savedCode) { $("code").value = savedCode; $("codeRow").classList.remove("hidden"); }

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  const notes = $("notes").value.trim();
  if (!url && !notes) return status("Paste a website or some details first.", true);

  $("go").disabled = true;
  const steps = ["Reading the website…", "Searching LinkedIn, Crunchbase and press…", "Checking headcount and funding…", "Almost there…"];
  let i = 0; status(steps[0]);
  const timer = setInterval(() => status(steps[Math.min(++i, steps.length - 1)]), 5000);

  try {
    const code = $("code").value.trim();
    const res = await fetch("/api/qualify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, notes, code }),
    });
    const data = await res.json().catch(() => ({ error: "The server returned an unexpected response." }));
    if (!res.ok) {
      if (data.needCode) { $("codeRow").classList.remove("hidden"); $("code").focus(); }
      throw new Error(data.error || `Error ${res.status}`);
    }
    if (code) store.set("icp-code", code);
    facts = data.facts; sources = data.sources || [];
    fillFacts(); render();
    status(data.siteRead || !url ? "" : "Couldn't open the website directly, so search results were used.");
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    status(err.message, true);
  } finally {
    clearInterval(timer); $("go").disabled = false;
  }
});

document.querySelectorAll("#facts [data-f]").forEach((el) => {
  el.addEventListener("input", () => {
    if (!facts) return;
    const k = el.dataset.f;
    facts[k] = el.type === "checkbox" ? el.checked : el.value === "" ? null : el.value;
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
