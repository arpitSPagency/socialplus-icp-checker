// Company research with Gemini + Google Search + URL context, called straight
// from the browser. Returns FACTS only; public/tiers.js decides the tier.

export function buildPrompt({ url, notes }) {
  return `You are a B2B sales researcher for Social+, a brand & growth agency. Research ONE company and report facts for lead qualification.

INPUT
Website: ${url || "(none given)"}
Notes pasted by the rep (may include LinkedIn text, founder bio, anything):
"""${notes || "(none)"}"""

HOW TO RESEARCH
${url ? `Read the website ${url} (home and About pages) first.` : ""}
Use Google Search. Look for: the company's LinkedIn page (employee band like "11-50"), Crunchbase / Tracxn / press for funding, the About/Contact page for HQ, founders and marketing leaders, recent launches, funding, expansion or hiring for brand/marketing roles.
If the pasted notes name a founder or person, use them to identify the right company.
Facts only. If you cannot find something, use null. Never guess a number.
HQ country = where the company is headquartered / primarily operates. An Indian company with a US mailing address is still India.

Return ONLY a JSON object, no prose, no code fences:
{
  "company": string,
  "website": string|null,
  "one_liner": string (what they do, max 20 words),
  "hq_country": string|null (full country name, e.g. "United States", "India"),
  "hq_city": string|null,
  "employees_min": number|null,
  "employees_max": number|null,
  "employees_source": string|null (e.g. "LinkedIn band 11-50"),
  "funding_usd": number|null (total raised in USD; null if bootstrapped/unknown),
  "last_round": string|null (e.g. "Seed, Mar 2025"),
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
  "notes": string|null (anything a rep should double-check, max 30 words)
}`;
}

// Google retires model names regularly, and free-tier quotas differ per model
// (some are 0). Try models in order; on "retired" or "quota" move to the next.
export const FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-flash-latest", "gemini-3-flash", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-2.5-flash-lite"];
const RETIRED = /no longer available|not found|is not supported|not available|deprecated|unknown model/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function research({ key, model, url, notes, onStatus = () => {}, wait = sleep }) {
  url = normalizeUrl(url);
  notes = String(notes || "").slice(0, 8000);
  if (!url && notes.trim().length < 3) throw new Error("Paste a website or some details first.");

  const models = [...new Set([model, ...FALLBACK_MODELS].filter(Boolean))];
  let quotaHit = false, lastErr;

  // Pass 1: full research (website + Google Search). Pass 2: website only,
  // which uses a separate, larger quota than search grounding.
  for (const search of [true, false]) {
    for (const m of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const out = await callModel({ key, model: m, url, notes, search });
          return { ...out, model: m, searched: search };
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
          throw e;
        }
      }
    }
    if (!url) break;
  }
  if (quotaHit) throw new Error("The free Gemini quota is used up for now. Try again in a few minutes. To stop this, turn on billing for the key in Google AI Studio (costs cents per check).");
  throw new Error("No Gemini model is available for this key. " + (lastErr?.message || ""));
}

async function callModel({ key, model, url, notes, search = true }) {
  const tools = [];
  if (search) tools.push({ google_search: {} });
  if (url) tools.push({ url_context: {} });

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt({ url, notes }) }] }],
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
    if (res.status === 400 && /API key/i.test(msg)) throw new Error("The Gemini API key is invalid.", { cause: "badKey" });
    if (res.status === 403) throw new Error("The Gemini key refused this site. Check the key's website restriction includes this page's address.", { cause: "badKey" });
    throw new Error(msg);
  }

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const facts = parseJson(text);
  if (!facts) throw new Error("The research came back in an unexpected format. Try again.");

  const seen = new Set();
  const sources = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web).filter(Boolean)
    .filter((w) => !seen.has(w.title) && seen.add(w.title))
    .slice(0, 8)
    .map((w) => ({ title: w.title, uri: w.uri }));
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
