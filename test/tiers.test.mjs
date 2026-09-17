import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../public/tiers.js";
import { parseJson, normalizeUrl, buildPrompt } from "../public/research.js";

const base = { hq_country: "United States", employees_min: 11, employees_max: 50, funding_usd: 3e6, segment: "SaaS", segment_fit: true, tiny_operation: false, low_budget: false };
const t = (over) => evaluate({ ...base, ...over });

test("US 11–50 → A", () => assert.equal(t({}).tier, "A"));
test("UK 51–200 → B", () => assert.equal(t({ hq_country: "United Kingdom", employees_min: 51, employees_max: 200 }).tier, "B"));
test("exactly 50 → A, 51 → B", () => {
  assert.equal(t({ employees_min: 50, employees_max: 50 }).tier, "A");
  assert.equal(t({ employees_min: 51, employees_max: 51 }).tier, "B");
});
test("201–500 → B, above profile, Nikita", () => {
  const v = t({ employees_min: 201, employees_max: 500 });
  assert.equal(v.tier, "B"); assert.ok(v.borderline); assert.match(v.flags.join(), /Above profile/);
});
test("India → C", () => assert.equal(t({ hq_country: "India", employees_min: 51, employees_max: 200 }).tier, "C"));
test("India 1–5 → D", () => assert.equal(t({ hq_country: "India", employees_min: 2, employees_max: 5 }).tier, "D"));
test("tiny op anywhere → D", () => assert.equal(t({ tiny_operation: true }).tier, "D"));
test("low budget → D", () => assert.equal(t({ low_budget: true }).tier, "D"));
test("Germany (EU) → A", () => assert.equal(t({ hq_country: "Germany" }).tier, "A"));
test("UAE → A", () => assert.equal(t({ hq_country: "UAE" }).tier, "A"));
test("Singapore → A with borderline flag", () => {
  const v = t({ hq_country: "Singapore" }); assert.equal(v.tier, "A"); assert.ok(v.borderline);
});
test("unknown headcount + $1M+ → provisional A", () => {
  const v = t({ employees_min: null, employees_max: null }); assert.equal(v.tier, "A"); assert.match(v.label, /Provisional/);
});
test("unknown headcount, no funding → no tier", () => assert.equal(t({ employees_min: null, employees_max: null, funding_usd: null }).tier, null));
test("unknown country → provisional", () => assert.match(t({ hq_country: null }).label, /Provisional/));
test("string inputs from form fields work", () => assert.equal(t({ employees_min: "60", employees_max: "" }).tier, "B"));
test("non-core segment flags Nikita", () => assert.ok(t({ segment_fit: false }).borderline));

test("parseJson handles fences and prose", () => {
  assert.deepEqual(parseJson('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJson("nope"), null);
});
test("normalizeUrl", () => {
  assert.equal(normalizeUrl("acme.com"), "https://acme.com/");
  assert.equal(normalizeUrl("hello"), null);
});
test("prompt includes url and notes", () => {
  const p = buildPrompt({ url: "https://acme.com/", notes: "Founder Jane" });
  assert.match(p, /acme\.com/); assert.match(p, /Founder Jane/);
});

test("research falls back when a model is retired", async () => {
  const { research } = await import("../public/research.js");
  const tried = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const m = decodeURIComponent(String(u).match(/models\/([^:]+):/)[1]);
    tried.push(m);
    if (m === "gemini-2.5-flash") return new Response(JSON.stringify({ error: { message: "This model models/gemini-2.5-flash is no longer available to new users." } }), { status: 404 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"X","hq_country":"India"}' }] } }] }), { status: 200 });
  };
  try {
    const r = await research({ key: "k", model: "gemini-2.5-flash", url: "x.com" });
    assert.equal(r.facts.company, "X");
    assert.deepEqual(tried, ["gemini-2.5-flash", "gemini-3.6-flash"]);
  } finally { globalThis.fetch = real; }
});
test("research does not retry on a bad key", async () => {
  const { research } = await import("../public/research.js");
  let n = 0; const real = globalThis.fetch;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }); };
  try { await assert.rejects(research({ key: "k", url: "x.com" }), /invalid/); assert.equal(n, 1); }
  finally { globalThis.fetch = real; }
});

test("quota on one model falls through to the next", async () => {
  const { research } = await import("../public/research.js");
  const tried = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const m = decodeURIComponent(String(u).match(/models\/([^:]+):/)[1]);
    const search = JSON.parse(o.body).tools?.some((t) => t.google_search);
    tried.push(m + (search ? "+s" : ""));
    if (search) return new Response(JSON.stringify({ error: { message: "Quota exceeded, limit: 0", details: [{ retryDelay: "5s" }] } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"Y"}' }] } }] }), { status: 200 });
  };
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "y.com", wait: async () => {} });
    assert.equal(r.facts.company, "Y"); assert.equal(r.searched, false);
    assert.equal(tried[0], "gemini-3.6-flash+s"); assert.equal(tried.at(-1), "gemini-3.6-flash");
  } finally { globalThis.fetch = real; }
});
test("short rate limit waits and retries same model", async () => {
  const { research } = await import("../public/research.js");
  let n = 0; let waited = 0; const real = globalThis.fetch;
  globalThis.fetch = async () => (++n === 1
    ? new Response(JSON.stringify({ error: { message: "Resource exhausted", details: [{ retryDelay: "3s" }] } }), { status: 429 })
    : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"Z"}' }] } }] }), { status: 200 }));
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "z.com", wait: async (ms) => { waited = ms; } });
    assert.equal(r.facts.company, "Z"); assert.equal(waited, 3000); assert.equal(n, 2); assert.ok(r.searched);
  } finally { globalThis.fetch = real; }
});

const TODAY = new Date(2026, 8, 17);
const tf = (over) => evaluate({ ...base, ...over }, TODAY);
test("seed → A even at 51–200", () => assert.equal(tf({ employees_min: 51, employees_max: 200, last_round: "Seed, Jan 2023" }).tier, "A"));
test("pre-seed → A", () => assert.equal(tf({ last_round_stage: "pre-seed" }).tier, "A"));
test("recent Series → A even at 51–200", () => {
  const v = tf({ employees_min: 51, employees_max: 200, last_round_stage: "series", last_round_date: "2026-03" });
  assert.equal(v.tier, "A"); assert.match(v.label, /Recent Series/);
});
test("old Series → B even at 11–50", () => assert.equal(tf({ last_round: "Series B, Mar 2024" }).tier, "B"));
test("Series, date unknown → B with flag", () => {
  const v = tf({ last_round_stage: "series" }); assert.equal(v.tier, "B"); assert.match(v.flags.join(), /date unknown/);
});
test("exactly 12 months → A, 13 → B", () => {
  assert.equal(tf({ last_round_stage: "series", last_round_date: "2025-09" }).tier, "A");
  assert.equal(tf({ last_round_stage: "series", last_round_date: "2025-08" }).tier, "B");
});
test("manual stage overrides AI text", () => assert.equal(tf({ last_round: "Seed, 2024", last_round_stage: "series", last_round_date: "2023-01" }).tier, "B"));
test("seed with unknown headcount → A, not provisional", () => {
  const v = tf({ employees_min: null, employees_max: null, last_round_stage: "seed" });
  assert.equal(v.tier, "A"); assert.doesNotMatch(v.label, /Provisional/);
});
test("India seed still C", () => assert.equal(tf({ hq_country: "India", last_round_stage: "seed" }).tier, "C"));
test("seed but tiny op → D", () => assert.equal(tf({ last_round_stage: "seed", tiny_operation: true }).tier, "D"));
