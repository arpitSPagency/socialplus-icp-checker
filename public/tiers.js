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

export function evaluate(f) {
  const flags = [];
  const checks = [];
  const geo = geoOf(f.hq_country);
  const emp = headcount(f);
  const raised = num(f.funding_usd);
  const tiny = f.tiny_operation === true;
  const lowBudget = f.low_budget === true;

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
    value: raised == null ? "Unknown / bootstrapped" : fmtUSD(raised) + (f.last_round ? ` (${f.last_round})` : ""),
    pass: raised == null ? null : raised >= 1e6,
    note: raised == null ? "Not a blocker on its own" : raised >= 1e6 ? "$1M+ raised" : "Under $1M raised",
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
  let tier = null;
  if (emp == null) {
    tier = raised != null && raised >= 1e6 ? "A" : null;
    flags.push(tier ? "Headcount unconfirmed. Provisional A on funding alone. Confirm size before outreach." : "Headcount unconfirmed. Add it below to get a tier.");
  } else if (emp <= 50) tier = "A";
  else tier = "B";

  if (emp != null && emp > 200) flags.push("Above profile (200+ employees). Still worked as B, but needs Nikita's sign-off. Pitch specialist value, not capacity.");
  if (geo === "other") flags.push(`Outside the target markets (${f.hq_country}). Borderline. Escalate to Nikita.`);
  if (geo === "unknown") flags.push("HQ country unconfirmed. Add it below.");
  if (f.segment_fit === false) flags.push("Segment is outside the core list. Borderline. Escalate to Nikita.");
  if (f.confidence === "low") flags.push("The research came back low confidence. Double-check the facts below.");

  if (!tier || geo === "unknown" || emp == null) {
    return result(tier, tier ? `Provisional ${tier}` : "Needs info", "Fill in the missing facts below. The tier updates instantly.", flags, checks);
  }
  const label = tier === "A" ? "International · up to 50" : "International · 51–200";
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
