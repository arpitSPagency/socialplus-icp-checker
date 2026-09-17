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
