import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../public/tiers.js";
import { parseJson, normalizeUrl, buildPrompt } from "../public/research.js";
import { mdLinks, unwrap, searchDigest, personIn, linkedinSlug, guessSlugs, gather, companyName, hasHeadcount } from "../public/gather.js";

// Research tests stub the browser-side evidence gathering so the mocked fetch
// only ever sees Gemini calls.
const NO_EVIDENCE = async () => ({ material: [], sources: [] });
const EVIDENCE = async () => ({ material: [{ title: "LinkedIn", url: "https://www.linkedin.com/company/x", text: "Company size 11-50 employees" }], sources: [{ title: "LinkedIn", uri: "https://www.linkedin.com/company/x" }] });

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
test("prompt includes url, notes and evidence", () => {
  const p = buildPrompt({ url: "https://acme.com/", notes: "Founder Jane", material: [{ title: "LinkedIn", url: "https://linkedin.com/company/acme", text: "Company size 11-50" }] });
  assert.match(p, /acme\.com/); assert.match(p, /Founder Jane/); assert.match(p, /EVIDENCE/); assert.match(p, /Company size 11-50/);
  assert.doesNotMatch(buildPrompt({ url: "https://acme.com/" }), /EVIDENCE/);
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
    const r = await research({ key: "k", model: "gemini-2.5-flash", url: "x.com", gatherFn: NO_EVIDENCE });
    assert.equal(r.facts.company, "X");
    assert.deepEqual(tried, ["gemini-2.5-flash", "gemini-3.6-flash"]);
  } finally { globalThis.fetch = real; }
});
test("research does not retry on a bad key", async () => {
  const { research } = await import("../public/research.js");
  let n = 0; const real = globalThis.fetch;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }); };
  try { await assert.rejects(research({ key: "k", url: "x.com", gatherFn: NO_EVIDENCE }), /invalid/); assert.equal(n, 1); }
  finally { globalThis.fetch = real; }
});

test("evidence goes to the model first; grounding is only a fallback", async () => {
  const { research } = await import("../public/research.js");
  const calls = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const body = JSON.parse(o.body);
    calls.push({ search: !!body.tools?.some((t) => t.google_search), evidence: /EVIDENCE/.test(body.contents[0].parts[0].text) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"Y","sources":[{"title":"Press","url":"https://press.example/a"},{"title":"DDG","url":"https://html.duckduckgo.com/html/?q=x"}]}' }] } }] }), { status: 200 });
  };
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "y.com", gatherFn: EVIDENCE });
    assert.equal(r.facts.company, "Y"); assert.equal(r.mode, "web"); assert.equal(r.evidence, 1);
    assert.deepEqual(calls, [{ search: false, evidence: true }]);
    assert.deepEqual(r.sources.map((s) => s.uri), ["https://www.linkedin.com/company/x", "https://press.example/a"]);
    assert.equal(r.facts.sources, undefined);
  } finally { globalThis.fetch = real; }
});
test("quota on every model in web mode falls through to grounded, then site", async () => {
  const { research } = await import("../public/research.js");
  const tried = []; const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const m = decodeURIComponent(String(u).match(/models\/([^:]+):/)[1]);
    const body = JSON.parse(o.body);
    const mode = body.tools?.some((t) => t.google_search) ? "grounded" : /EVIDENCE/.test(body.contents[0].parts[0].text) ? "web" : "site";
    tried.push(m + ":" + mode);
    if (mode !== "site") return new Response(JSON.stringify({ error: { message: "Quota exceeded, limit: 0" } }), { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"Y"}' }] } }] }), { status: 200 });
  };
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "y.com", wait: async () => {}, gatherFn: EVIDENCE });
    assert.equal(r.facts.company, "Y"); assert.equal(r.mode, "site"); assert.equal(r.searched, false);
    assert.equal(tried[0], "gemini-3.6-flash:web"); assert.ok(tried.includes("gemini-3.6-flash:grounded")); assert.equal(tried.at(-1), "gemini-3.6-flash:site");
  } finally { globalThis.fetch = real; }
});
test("a 503 moves on to the next model instead of failing", async () => {
  const { research } = await import("../public/research.js");
  const tried = []; let waited = 0; const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const m = decodeURIComponent(String(u).match(/models\/([^:]+):/)[1]);
    tried.push(m);
    if (m === "gemini-3.6-flash") return new Response(JSON.stringify({ error: { message: "The service is currently unavailable." } }), { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"W"}' }] } }] }), { status: 200 });
  };
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "w.com", wait: async (ms) => { waited += ms; }, gatherFn: NO_EVIDENCE });
    assert.equal(r.facts.company, "W"); assert.equal(r.model, "gemini-3-flash-preview");
    assert.deepEqual(tried, ["gemini-3.6-flash", "gemini-3.6-flash", "gemini-3-flash-preview"]); assert.ok(waited > 0);
  } finally { globalThis.fetch = real; }
});
test("a failed gather still produces a result", async () => {
  const { research } = await import("../public/research.js");
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"V"}' }] } }] }), { status: 200 });
  try {
    const r = await research({ key: "k", url: "v.com", gatherFn: async () => { throw new Error("reader down"); } });
    assert.equal(r.facts.company, "V"); assert.equal(r.evidence, 0);
  } finally { globalThis.fetch = real; }
});

const DDG_MD = `[Cal.com | LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fcal%2Dcom%2F&rut=abc)
Cal.com | 5,000 followers. Company size 11-50 employees.
[![Image 3](https://external-content.duckduckgo.com/ip3/x.ico)](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fcal%2Dcom%2F&rut=abc)
[Cal.com Funding | StartupIntros](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fstartupintros.com%2Forgs%2Fcal%2Dcom&rut=def)
[Cal.com - Crunchbase](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.crunchbase.com%2Forganization%2Fcal%2Dcom&rut=ghi)`;
const BING_MD = `### [Cal.com: Funding, Team & Investors | Startup Intros](https://startupintros.com/orgs/cal-com)
Cal.com has raised $32.0M across 2 funding rounds.
[https://startupintros.com/orgs/cal-com](https://startupintros.com/orgs/cal-com)
### [California - Wikipedia](https://en.wikipedia.org/wiki/California)
### [Cal.com (company) - Wikipedia](https://en.wikipedia.org/wiki/Cal.com_(company))
### [Open source Calendly rival Cal.com raises $25M](http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3a%2f%2fventurebeat.com%2fcal-com-raises-25m&c=1)
Fri, 15 Apr 2022 12:06:00 GMT`;
test("mdLinks decodes DuckDuckGo and Bing wrappers, keeps parenthesised URLs, drops icons and bare URLs", () => {
  assert.deepEqual(mdLinks(DDG_MD).map((l) => l.href), ["https://www.linkedin.com/company/cal-com/", "https://startupintros.com/orgs/cal-com", "https://www.crunchbase.com/organization/cal-com"]);
  assert.deepEqual(mdLinks(BING_MD), [
    { title: "Cal.com: Funding, Team & Investors | Startup Intros", href: "https://startupintros.com/orgs/cal-com" },
    { title: "California - Wikipedia", href: "https://en.wikipedia.org/wiki/California" },
    { title: "Cal.com (company) - Wikipedia", href: "https://en.wikipedia.org/wiki/Cal.com_(company)" },
    { title: "Open source Calendly rival Cal.com raises $25M", href: "https://venturebeat.com/cal-com-raises-25m" },
  ]);
  assert.equal(unwrap("https://www.bing.com/search?q=x"), null);
});
test("searchDigest keeps titles, snippets, dates and real targets", () => {
  const d = searchDigest(BING_MD);
  assert.match(d, /Startup Intros <https:\/\/startupintros\.com\/orgs\/cal-com>/);
  assert.match(d, /raises \$25M <https:\/\/venturebeat\.com\/cal-com-raises-25m>/);
  assert.match(d, /15 Apr 2022/); assert.doesNotMatch(d, /apiclick/);
  assert.doesNotMatch(searchDigest(DDG_MD), /Image 3|duckduckgo\.com\/l\//);
});
test("personIn finds a named founder in notes", () => {
  assert.equal(personIn("Founder: Jane Doe, ex-Stripe"), "Jane Doe");
  assert.equal(personIn("nothing here"), null);
});
test("linkedinSlug and guessSlugs", () => {
  assert.equal(linkedinSlug("Follow us: https://www.linkedin.com/company/lovable-dev/ and X"), "lovable-dev");
  assert.equal(linkedinSlug("no link"), null);
  assert.deepEqual(guessSlugs("cal.com"), ["cal-com", "cal"]);
});
test("gather: site -> LinkedIn slug -> LinkedIn page, StartupIntros, named funding pages, news", async () => {
  const fetched = [];
  const fetchText = async (u) => {
    fetched.push(u);
    if (u === "https://cal.com/") return "Cal.com scheduling. Follow https://www.linkedin.com/company/cal-com on LinkedIn. ".repeat(5);
    if (/linkedin\.com\/company\/cal-com$/.test(u)) return "Cal.com | LinkedIn. Company size 11-50 employees. Headquarters San Francisco. ".repeat(5);
    if (/startupintros\.com\/orgs\/cal-com$/.test(u)) return "Cal.com has raised $32.0M across 2 funding rounds. Most recently Series A April 2022. ".repeat(5);
    if (/bing\.com\/news/.test(u)) return BING_MD;
    if (/bing\.com\/search/.test(u)) return BING_MD;
    if (/wikipedia\.org\/wiki\/Cal\.com_\(company\)/.test(u)) return "Cal.com is a company. ".repeat(20);
    throw new Error("unexpected " + u);
  };
  const r = await gather({ url: "https://cal.com/", notes: "", fetchText });
  assert.equal(r.linkedin, "https://www.linkedin.com/company/cal-com");
  assert.ok(!fetched.some((u) => /linkedin\.com\/company\/cal$/.test(u)), "no slug guessing when the site links LinkedIn");
  assert.ok(!fetched.some((u) => /wiki\/California/.test(u)), "California is not the company");
  assert.ok(!fetched.some((u) => /duckduckgo/.test(u)), "no DuckDuckGo when Bing answered");
  assert.deepEqual(r.material.map((m) => m.title.split(":")[0]), ["Website", "LinkedIn", "StartupIntros", "Cal.com (company) - Wikipedia", "Search results", "News headlines matching \"cal.com\" (check the company name matches)"]);
  assert.deepEqual(r.sources.map((s) => s.uri), ["https://www.linkedin.com/company/cal-com", "https://startupintros.com/orgs/cal-com", "https://en.wikipedia.org/wiki/Cal.com_(company)"]);
});
test("gather guesses the LinkedIn slug and falls back to DuckDuckGo, skipping a bot challenge", async () => {
  const fetched = [];
  const fetchText = async (u) => {
    fetched.push(u);
    if (u === "https://acme.io/") return "Acme makes widgets. ".repeat(20);
    if (/linkedin\.com\/company\/acme-io$/.test(u)) throw new Error("404");
    if (/linkedin\.com\/company\/acme$/.test(u)) return "Acme | LinkedIn. acme.io. Company size 2-10 employees. ".repeat(5);
    if (/startupintros/.test(u)) return "";
    if (/bing\.com/.test(u)) return "";
    if (/duckduckgo/.test(u)) return "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge. Select all squares containing a duck.";
    throw new Error("unexpected " + u);
  };
  const r = await gather({ url: "https://acme.io/", notes: "", fetchText });
  assert.equal(r.linkedin, "https://www.linkedin.com/company/acme");
  assert.ok(fetched.some((u) => /duckduckgo/.test(u)));
  assert.deepEqual(r.material.map((m) => m.title.split(":")[0]), ["Website", "LinkedIn"]);
});
test("gather survives a dead reader", async () => {
  const r = await gather({ url: "https://cal.com/", notes: "", fetchText: async () => { throw new Error("429"); } });
  assert.deepEqual(r, { material: [], sources: [], linkedin: null, name: "Cal" });
});
test("companyName: domain match, then stem match, then copyright, then shortest title segment", () => {
  assert.equal(companyName({ title: "Cal.com | Scheduling Software for Online Bookings", host: "cal.com" }), "Cal.com");
  assert.equal(companyName({ title: "Hiya Health | Essential Super Nutrients for Kids", text: "© Hiya Health Products LLC 2026. All Rights Reserved", host: "hiyahealth.com" }), "Hiya Health");
  assert.equal(companyName({ title: "Online Doctor Appointments, 24/7 | Maple", host: "getmaple.ca" }), "Maple");
  assert.equal(companyName({ title: "", text: "© 2026 Acme Widgets, Inc. All rights reserved.", host: "acmew.io" }), "Acme Widgets");
  assert.equal(companyName({ title: "Home", host: "acme.io" }), "Acme");
});
test("hasHeadcount spots bands and counts", () => {
  assert.ok(hasHeadcount([{ text: "Company size 11-50 employees" }]));
  assert.ok(hasHeadcount([{ text: "corporate office is in Florida and has 19 employees." }]));
  assert.ok(!hasHeadcount([{ text: "We love our employees. Join the team." }]));
});
test("gather finds the LinkedIn page and headcount snippets by name when the site never links it", async () => {
  const fetched = [];
  const fetchText = async (u) => {
    fetched.push(u);
    if (u === "https://hiyahealth.com/") return "Kids vitamins. © Hiya Health Products LLC 2026. All Rights Reserved. ".repeat(10);
    if (/linkedin\.com\/company\/hiyahealth(-com)?$/.test(u)) return "Page not found. ".repeat(20);
    // The Australian physio shares the name; it never mentions hiyahealth.com.
    if (/linkedin\.com\/company\/hiya-health$/.test(u)) return "Hiya Health | LinkedIn. Allied health, Queensland. Website hiya.health. Company size 51-200 employees. ".repeat(5);
    if (/linkedin\.com\/company\/hiya-health-products$/.test(u)) return "Hiya Health Products | LinkedIn. Website hiyahealth.com. Company size 11-50 employees. ".repeat(5);
    if (/duckduckgo.*employees/.test(u)) return [
      "1.[Hiya Health - LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fhiya-health%2F)\nQueensland physio.\n",
      "2.[Hiya Health Products: Employee Directory | ZoomInfo](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.zoominfo.com%2Fpic%2Fhiya-health-products%2F1)\n**Hiya Health** Products is located in West Palm Beach, Florida and has 19 **employees**.\n",
      "3.[Hiya Health Products - LinkedIn](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fcompany%2Fhiya-health-products%2F)\nKids vitamins.\n",
    ].join("\n");
    if (/bing\.com/.test(u)) return "";
    throw new Error("unexpected " + u);
  };
  const r = await gather({ url: "https://hiyahealth.com/", notes: "", fetchText });
  assert.equal(r.name, "Hiya Health Products", "no <title> in this double, so the copyright line names it");
  assert.equal(r.linkedin, "https://www.linkedin.com/company/hiya-health-products", "the page that names the domain wins");
  assert.ok(fetched.some((u) => /linkedin\.com\/company\/hiya-health$/.test(u)), "the namesake was checked and rejected");
  assert.ok(!fetched.some((u) => /site%3Alinkedin/.test(u)), "no second search once LinkedIn is found");
  assert.deepEqual(r.material.map((m) => m.title.split(":")[0]), ["Website", "LinkedIn", "Search results"]);
  assert.match(r.material[2].text, /has 19 \*\*employees\*\*/);
  assert.ok(!fetched.some((u) => /growjo/.test(u)), "Growjo is skipped once a headcount is in hand");
});
test("gather keeps a press page matched by name only when it mentions the domain", async () => {
  const fetched = [];
  const bing = [
    "### [Maple - Wikipedia](https://en.wikipedia.org/wiki/Maple)\nA tree.\n",
    "### [Maple raises $75M Series C - TechCrunch](https://techcrunch.com/maple-raises)\nThe telehealth company.\n",
  ].join("\n");
  const fetchText = async (u) => {
    fetched.push(u);
    if (u === "https://getmaple.ca/") return "Online doctors in Canada. ".repeat(20);
    if (/linkedin/.test(u)) return "Maple | LinkedIn. getmaple.ca. Company size 201-500 employees. ".repeat(5);
    if (/startupintros/.test(u)) return "";
    if (/bing\.com\/search/.test(u)) return bing;
    if (/bing\.com\/news/.test(u)) return "";
    if (/wikipedia/.test(u)) return "Maple is a genus of trees. ".repeat(20);
    if (/techcrunch/.test(u)) return "Maple (getmaple.ca) raised $75M. ".repeat(20);
    throw new Error("unexpected " + u);
  };
  const r = await gather({ url: "https://getmaple.ca/", notes: "", fetchText, fetchPage: async (u) => ({ title: "Online Doctors | Maple", content: await fetchText(u) }) });
  assert.equal(r.name, "Maple");
  const titles = r.material.map((m) => m.title);
  assert.ok(titles.some((t) => /TechCrunch/.test(t)), "press that names the domain is kept");
  assert.ok(!titles.some((t) => /Wikipedia/.test(t)), "the tree is not the company");
});
test("short rate limit waits and retries same model", async () => {
  const { research } = await import("../public/research.js");
  let n = 0; let waited = 0; const real = globalThis.fetch;
  globalThis.fetch = async () => (++n === 1
    ? new Response(JSON.stringify({ error: { message: "Resource exhausted", details: [{ retryDelay: "3s" }] } }), { status: 429 })
    : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"company":"Z"}' }] } }] }), { status: 200 }));
  try {
    const r = await research({ key: "k", model: "gemini-3.6-flash", url: "z.com", wait: async (ms) => { waited = ms; }, gatherFn: NO_EVIDENCE });
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
