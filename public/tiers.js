// Social+ ICP tier rules. This is the ONLY place tiers are decided.
// The AI only gathers facts; these rules turn facts into a tier, so the
// same facts always give the same answer.
//
// Tiers (set by Arpit, 17 Sep 2026):
//   A  International target market, up to 50 employees
//   B  International target market, 51–200 employees
//   C  India
//   D  Decline politely, never chase (old Tier C: 1–5 person op,
//      no strategy, transactional, budget under $500/mo or ₹40K/mo)

export const TARGET_SEGMENTS = [
  "SaaS", "AI-native", "DTC / e-commerce", "Hospitality", "Real estate",
  "Health / fintech", "B2B services",
];

const EU = [
  "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "czech republic",
  "denmark", "estonia", "finland", "france", "germany", "greece", "hungary", "ireland",
  "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands", "the netherlands",
  "poland", "portugal", "romania", "slovakia", "slovenia", "spain", "sweden",
];
const TARGET_COUNTRIES = new Set([
  "united states", "usa", "us", "u.s.", "united states of america", "america",
  "united kingdom", "uk", "u.k.", "england", "scotland", "wales", "northern ireland", "great britain",
  "canada", "australia",
  "united arab emirates", "uae", "dubai", "abu dhabi",
  "european union", "eu", ...EU,
]);

export function geoOf(country) {
  const c = String(country || "").trim().toLowerCase();
  if (!c) return "unknown";
  if (c === "india" || c === "in" || c === "bharat") return "india";
  if (TARGET_COUNTRIES.has(c)) return "target";
  return "other";
}

// One headcount number to band on. LinkedIn-style ranges ("11–50") use the top
// of the range, so "11–50" is A and "51–200" is B.
export function headcount(f) {
  const max = num(f.employees_max);
  const min = num(f.employees_min);
  if (max != null) return max;
  if (min != null) return min;
  return null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && String(v).match(/\d/) ? n : null;
}

export function fmtUSD(n) {
  n = num(n);
  if (n == null) return "Unknown";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

// Funding stage (set by Arpit, 17 Sep 2026):
//   Pre-seed / Seed      → Tier A (dream fit)
//   Series A, B, C…      → Tier A if the round is recent (last 12 months), else Tier B
// A known stage beats the headcount bands. Headcount decides only when no round is known.
export const RECENT_MONTHS = 12;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function stageOf(f) {
  const t = (f.last_round_stage ? String(f.last_round_stage) : String(f.last_round || "")).toLowerCase();
  if (/pre[\s-]?seed/.test(t)) return "pre-seed";
  if (/\bseed\b|angel/.test(t)) return "seed";
  if (/series\s*[a-z]\b|series/.test(t)) return "series";
  return null;
}

// Months since the last round, from last_round_date ("2025-03" / "2025-03-14")
// or a month/year inside last_round ("Series A, Mar 2025"). null if unknown.
export function roundAgeMonths(f, today = new Date()) {
  let y, m = 6;
  const d = String(f.last_round_date || "").match(/(\d{4})(?:-(\d{1,2}))?/);
  if (d) { y = +d[1]; if (d[2]) m = +d[2]; }
  else {
    const t = String(f.last_round || "").toLowerCase();
    const ym = t.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{4})/);
    const yo = t.match(/\b(20\d{2})\b/);
    if (ym) { m = MONTHS[ym[1]]; y = +ym[2]; } else if (yo) y = +yo[1];
  }
  if (!y) return null;
  return (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
}

function roundText(f) {
  const st = stageOf(f);
  const name = f.last_round || (st ? st[0].toUpperCase() + st.slice(1) : "");
  const date = f.last_round_date && !String(f.last_round || "").includes(String(f.last_round_date).slice(0, 4)) ? ` · ${f.last_round_date}` : "";
  return name + date;
}

export function evaluate(f, today = new Date()) {
  const flags = [];
  const checks = [];
  const geo = geoOf(f.hq_country);
  const emp = headcount(f);
  const raised = num(f.funding_usd);
  const tiny = f.tiny_operation === true;
  const lowBudget = f.low_budget === true;
  const stage = stageOf(f);
  const age = roundAgeMonths(f, today);
  const recent = age != null && age <= RECENT_MONTHS;

  checks.push({
    param: "Geography",
    value: f.hq_country || "Unknown",
    pass: geo === "target" ? true : geo === "india" ? true : geo === "unknown" ? null : false,
    note: { target: "International target market", india: "India → Tier C", other: "Outside US/UK/CA/AU/UAE/EU and not India", unknown: "Could not confirm HQ" }[geo],
  });
  checks.push({
    param: "Employees",
    value: emp == null ? "Unknown" : rangeText(f),
    pass: emp == null ? null : emp > 5,
    note: emp == null ? "Could not confirm headcount" : emp <= 5 ? "1–5 person operation" : emp <= 50 ? "Up to 50 → A band" : emp <= 200 ? "51–200 → B band" : "Above 200 → above profile",
  });
  checks.push({
    param: "Funding",
    value: [raised != null && fmtUSD(raised), roundText(f)].filter(Boolean).join(" · ") || "Unknown / bootstrapped",
    pass: stage ? true : raised == null ? null : raised >= 1e6,
    note: stage === "pre-seed" || stage === "seed" ? "Seed / pre-seed → dream fit, Tier A"
      : stage === "series" ? (recent ? `Recent Series round (${age} mo ago) → Tier A` : age != null ? `Series round ${age} mo ago → Tier B` : "Series round, date unknown → Tier B")
      : raised == null ? "No round found. Headcount decides" : raised >= 1e6 ? "$1M+ raised, stage unknown. Headcount decides" : "Under $1M raised, stage unknown. Headcount decides",
  });
  checks.push({
    param: "Segment",
    value: f.segment || "Unknown",
    pass: f.segment_fit === true ? true : f.segment_fit === false ? false : null,
    note: f.segment_fit === false ? "Not a core Social+ segment" : f.segment_fit === true ? "Core segment" : "Unclear",
  });
  checks.push({
    param: "Strategy / budget",
    value: tiny || lowBudget ? "Red flags" : "No red flags",
    pass: !(tiny || lowBudget),
    note: [tiny && "Solo/tiny or transactional", lowBudget && "Budget likely under $500/mo (₹40K)"].filter(Boolean).join(" · ") || "Nothing suggests a sub-$500/mo buyer",
  });

  // 1. Decline beats everything, in every geography.
  if (tiny || lowBudget || (emp != null && emp <= 5)) {
    return result("D", "Decline", "Decline politely. Never chase.", flags, checks);
  }

  // 2. India is its own tier.
  if (geo === "india") {
    if (emp == null) flags.push("Headcount unconfirmed. Check it isn't a 1–5 person operation before working it.");
    if (f.segment_fit === false) flags.push("Segment is outside the core list. Get Nikita's view.");
    return result("C", "India", "India lead. Work it on the India approach.", flags, checks);
  }

  // 3. International.
  let tier = null, basis = null;
  if (stage === "pre-seed" || stage === "seed") { tier = "A"; basis = stage === "seed" ? "Seed" : "Pre-seed"; }
  else if (stage === "series") {
    tier = recent ? "A" : "B"; basis = recent ? "Recent Series round" : "Series round";
    if (age == null) flags.push("Series round date unknown. Treated as B. If it closed in the last 12 months, set the date and it becomes A.");
  } else if (emp == null) {
    tier = raised != null && raised >= 1e6 ? "A" : null;
    flags.push(tier ? "Headcount unconfirmed. Provisional A on funding alone. Confirm size before outreach." : "Headcount unconfirmed. Add it below to get a tier.");
  } else if (emp <= 50) { tier = "A"; basis = "up to 50"; }
  else { tier = "B"; basis = "51–200"; }
  if (stage && emp == null) flags.push("Headcount unconfirmed. Check it isn't a 1–5 person operation.");

  if (emp != null && emp > 200) flags.push(`Above profile (200+ employees). Still worked as ${tier}, but needs Nikita's sign-off. Pitch specialist value, not capacity.`);
  if (geo === "other") flags.push(`Outside the target markets (${f.hq_country}). Borderline. Escalate to Nikita.`);
  if (geo === "unknown") flags.push("HQ country unconfirmed. Add it below.");
  if (f.segment_fit === false) flags.push("Segment is outside the core list. Borderline. Escalate to Nikita.");
  if (f.confidence === "low") flags.push("The research came back low confidence. Double-check the facts below.");

  if (!tier || geo === "unknown" || (emp == null && !stage)) {
    return result(tier, tier ? `Provisional ${tier}` : "Needs info", "Fill in the missing facts below. The tier updates instantly.", flags, checks);
  }
  const label = `International · ${basis}`;
  return result(tier, label, flags.length ? "Qualified, with flags. Check them before outreach." : "Qualified. Pursue.", flags, checks);
}

function rangeText(f) {
  const a = num(f.employees_min), b = num(f.employees_max);
  if (a != null && b != null && a !== b) return `${a}–${b}`;
  return String(b ?? a);
}

function result(tier, label, action, flags, checks) {
  const borderline = flags.some((x) => /Nikita|Provisional|unconfirmed/i.test(x));
  return { tier, label, action, flags, checks, borderline };
}
