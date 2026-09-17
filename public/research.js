// Company research with Gemini, called straight from the browser. Returns
// FACTS only; public/tiers.js decides the tier.
//
// Free-tier reality (checked 17 Sep 2026): Google Search grounding returns 429
// on every model for a free key, and search engines block Gemini's url_context
// fetcher. So the browser gathers the evidence itself (gather.js: DuckDuckGo
// results, the LinkedIn company page, funding pages, all through Jina's free
// reader) and Gemini reads the website plus that material. Search grounding
// is only tried after that, and the website alone is the last resort.

import { gather } from "./gather.js";

export function buildPrompt({ url, notes, material = [] }) {
  const domain = url ? hostOf(url) : null;
  return `You are a B2B sales researcher for Social+, a brand & growth agency. Research ONE company and report facts for lead qualification.

INPUT
Website: ${url || "(none given)"}
Notes pasted by the rep (may include LinkedIn text, founder bio, anything):
"""${notes || "(none)"}"""

HOW TO RESEARCH
${url ? `Read the website ${url} (home and About pages) first.` : ""}
${domain ? `The company is the one that owns ${domain}. The evidence was found by searching for that domain; if a page is clearly about a different company (different name, product or website), do not use it. If the website is only a placeholder or "launching soon" page, say so in notes and set confidence to "low".` : ""}
Look for: the LinkedIn company page (employee band like "11-50", headquarters), funding databases and press for rounds, the About/Contact page for HQ, founders and marketing leaders, recent launches, funding, expansion or hiring for brand/marketing roles.
If the pasted notes name a founder or person, use them to identify the right company.
Facts only. If you cannot find something, use null. Never guess a number.
If a number comes only from your own memory rather than a page you read, say so in its source field and set confidence to "low".
HQ country = where the company is headquartered / primarily operates. An Indian company with a US mailing address is still India.
${material.length ? `
EVIDENCE (pages fetched just now; search-result pages hold snippets from LinkedIn, funding databases and press). Prefer this over your own memory.
${material.map((m, i) => `--- [${i + 1}] ${m.title}\n${m.url}\n${m.text}`).join("\n\n")}
--- end of evidence
` : ""}
Return ONLY a JSON object, no prose, no code fences:
{
  "company": string,
  "website": string|null,
  "one_liner": string (what they do, max 20 words),
  "hq_country": string|null (full country name, e.g. "United States", "India"),
  "hq_city": string|null,
  "employees_min": number|null,
  "employees_max": number|null,
  "employees_source": string|null (e.g. "LinkedIn band 11-50", "website team page", "AI memory"),
  "funding_usd": number|null (total raised in USD; null if bootstrapped/unknown),
  "last_round": string|null (e.g. "Seed, Mar 2025"),
  "funding_source": string|null (e.g. "StartupIntros", "TechCrunch Apr 2022", "AI memory"),
  "last_round_stage": "pre-seed"|"seed"|"series"|null (series = Series A/B/C or later),
  "last_round_date": string|null (YYYY-MM of the most recent round; null if unknown),
  "segment": string (short label),
  "segment_fit": boolean (true if SaaS, AI-native, DTC/e-commerce, hospitality, real estate, health/fintech, or B2B services),
  "tiny_operation": boolean (true ONLY if clearly a solo founder/freelancer/1-5 person shop, or purely transactional one-off need),
  "low_budget": boolean (true ONLY if strong evidence they can't spend $500/month on marketing),
  "active_social_or_ads": boolean|null,
  "decision_makers": [{"name": string, "title": string}] (CEO/founder/CMO/marketing head; max 3),
  "buying_triggers": [string] (recent funding, launch, expansion, brand/marketing hiring; with dates; max 4),
  "confidence": "high"|"medium"|"low",
  "notes": string|null (anything a rep should double-check, max 30 words),
  "sources": [{"title": string, "url": string}] (the actual pages or snippets the facts came from, e.g. the LinkedIn page, a Crunchbase entry, a press article; not search-result pages; max 6)
}`;
}

// Google retires model names regularly, and free-tier quotas differ per model
// (some are 0). Try models in order; on "retired", "quota" or "busy" move on.
// gemini-2.5-* are "no longer available to new users" and stay out of the list.
export const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3-flash-preview", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-lite-latest"];

// Research modes, in the order they are tried.
//   web      evidence gathered in the browser (gather.js) + website via url_context
//   grounded Google Search grounding (usually quota 0 on a free key)
//   site     website only
export const MODES = ["web", "grounded", "site"];

const RETIRED = /no longer available|not found|is not supported|not available|deprecated|unknown model/i;
const TRANSIENT_WAIT_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function research({ key, model, url, notes, onStatus = () => {}, wait = sleep, gatherFn = gather }) {
  url = normalizeUrl(url);
  notes = String(notes || "").slice(0, 8000);
  if (!url && notes.trim().length < 3) throw new Error("Paste a website or some details first.");

  const models = [...new Set([model, ...FALLBACK_MODELS].filter(Boolean))];
  let quotaHit = false, lastErr;

  // Evidence is gathered once, up front, and reused across every model try.
  // A failed gather just means less evidence, never a failed check.
  let evidence = { material: [], sources: [] };
  try { evidence = await gatherFn({ url, notes, onStatus }); } catch {}
  onStatus("Reading the website and pulling the facts together…");

  for (const mode of MODES) {
    if (mode === "web" && !url && !evidence.material.length) continue;
    // "site" only differs from "web" when there was evidence to drop.
    if (mode === "site" && (!url || !evidence.material.length)) break;
    for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await callModel({ key, model: m, url, notes, mode, material: mode === "web" ? evidence.material : [] });
          const seen = new Set();
          const sources = [...evidence.sources, ...out.sources].filter((s) => !seen.has(s.uri) && seen.add(s.uri)).slice(0, 8);
          return { ...out, sources, model: m, mode, searched: mode !== "site", evidence: evidence.material.length };
        } catch (e) {
          lastErr = e;
          if (e.cause === "retired") break;
          if (e.cause === "quota") {
            quotaHit = true;
            // Short per-minute limit: wait once and retry the same model.
            if (attempt === 0 && e.retryMs && e.retryMs <= 20000) {
              onStatus(`Busy. Retrying in ${Math.ceil(e.retryMs / 1000)}s…`);
              await wait(e.retryMs);
              continue;
            }
            break;
          }
          if (e.cause === "transient") {
            // 500/503/504: the model is overloaded, not the key. One short
            // wait, then the next model. Never fatal on its own.
            if (attempt === 0) { onStatus("Gemini is busy. Retrying…"); await wait(TRANSIENT_WAIT_MS); continue; }
            break;
          }
          throw e;
        }
      }
    }
  }
  if (quotaHit) throw new Error("The free Gemini quota is used up for now. Try again in a few minutes, or fill in the facts yourself below.");
  if (lastErr?.cause === "transient") throw new Error("Gemini is busy right now. Try again in a minute, or fill in the facts yourself below.");
  throw new Error("No Gemini model is available for this key. " + (lastErr?.message || ""));
}

async function callModel({ key, model, url, notes, mode, material = [] }) {
  const tools = [];
  if (mode === "grounded") tools.push({ google_search: {} });
  if (url) tools.push({ url_context: {} });

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt({ url, notes, material }) }] }],
        ...(tools.length ? { tools } : {}),
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    throw new Error(e.name === "TimeoutError" ? "Research took too long. Try again." : "Couldn't reach Gemini. Check your connection.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini error ${res.status}`;
    if (res.status === 404 || RETIRED.test(msg)) throw new Error(msg, { cause: "retired" });
    if (res.status === 429 || /quota|rate limit|resource.?exhausted/i.test(msg)) {
      const delay = (data?.error?.details || []).find((d) => d.retryDelay)?.retryDelay;
      const secs = delay ? parseFloat(delay) : null;
      throw Object.assign(new Error(msg, { cause: "quota" }), { retryMs: /limit: 0/.test(msg) ? null : secs ? secs * 1000 : null });
    }
    if (res.status >= 500 || /high demand|unavailable|overloaded/i.test(msg)) throw new Error(msg, { cause: "transient" });
    if (res.status === 400 && /API key/i.test(msg)) throw new Error("The Gemini API key is invalid.", { cause: "badKey" });
    if (res.status === 403) throw new Error("The Gemini key refused this site. Check the key's website restriction includes this page's address.", { cause: "badKey" });
    throw new Error(msg);
  }

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const facts = parseJson(text);
  if (!facts) throw new Error("The research came back in an unexpected format. Try again.");

  // Sources: grounding chunks when grounded, plus what the model cited, and
  // never a raw search-results page.
  const seen = new Set();
  const grounded = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title, uri: w.uri }));
  const cited = (Array.isArray(facts.sources) ? facts.sources : []).filter((s) => s && s.url).map((s) => ({ title: s.title || s.url, uri: s.url }));
  const sources = [...grounded, ...cited]
    .filter((s) => /^https?:\/\//.test(s.uri) && !/duckduckgo\.com/.test(s.uri))
    .filter((s) => !seen.has(s.uri) && seen.add(s.uri))
    .slice(0, 8);
  delete facts.sources;
  return { facts, sources };
}

export function parseJson(text) {
  if (!text) return null;
  const s = text.replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

export function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    const p = new URL(u);
    if (!p.hostname.includes(".")) return null;
    return p.toString();
  } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
