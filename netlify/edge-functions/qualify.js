// POST /api/qualify  { url?, notes?, code? }  ->  { facts, sources, model, siteRead }
// Researches a company with Gemini + Google Search and returns FACTS only.
// The tier itself is decided in public/tiers.js, so it stays consistent.
//
// Netlify environment variables:
//   GEMINI_API_KEY  (required)  Google AI Studio key. Never sent to the browser.
//   ACCESS_CODE     (optional)  Team passcode, so strangers can't spend the key.
//   GEMINI_MODEL    (optional)  Defaults to gemini-2.5-flash.

export const config = { path: "/api/qualify" };

const env = (k) => (globalThis.Netlify?.env?.get(k) ?? globalThis.Deno?.env?.get(k) ?? globalThis.process?.env?.[k]);

export default async (request) => {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);

  const key = env("GEMINI_API_KEY");
  if (!key) return json({ error: "The server has no GEMINI_API_KEY yet. Add it in Netlify → Site configuration → Environment variables, then redeploy." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  const access = env("ACCESS_CODE");
  if (access && String(body.code || "").trim() !== access) {
    return json({ error: "Wrong or missing team access code.", needCode: true }, 401);
  }

  const url = normalizeUrl(body.url);
  const notes = String(body.notes || "").slice(0, 8000);
  if (!url && notes.trim().length < 3) return json({ error: "Paste a website or some details first." }, 400);

  const site = url ? await readSite(url) : null;
  const model = env("GEMINI_MODEL") || "gemini-2.5-flash";

  try {
    const { text, sources } = await askGemini({ key, model, url, notes, site });
    const facts = parseJson(text);
    if (!facts) return json({ error: "The research came back in an unexpected format. Try again." }, 502);
    return json({ facts, sources, model, siteRead: !!site?.text });
  } catch (e) {
    return json({ error: e.message || "Research failed." }, 502);
  }
};

export function buildPrompt({ url, notes, site }) {
  return `You are a B2B sales researcher for Social+, a brand & growth agency. Research ONE company and report facts for lead qualification.

INPUT
Website: ${url || "(none given)"}
Notes pasted by the rep (may include LinkedIn text, founder bio, anything):
"""${notes || "(none)"}"""
${site?.text ? `Homepage text (fetched just now, may be partial):\n"""${site.text}"""` : "Homepage could not be fetched; rely on search."}

HOW TO RESEARCH
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

async function askGemini({ key, model, url, notes, site }) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: buildPrompt({ url, notes, site }) }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(36000),
  }).catch((e) => { throw new Error(e.name === "TimeoutError" ? "Research took too long. Try again." : "Couldn't reach Gemini."); });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini error ${res.status}`;
    throw new Error(res.status === 429 ? "Gemini rate limit hit. Wait a minute and retry." : msg);
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const seen = new Set();
  const sources = (cand?.groundingMetadata?.groundingChunks || [])
    .map((c) => c.web).filter(Boolean)
    .filter((w) => !seen.has(w.title) && seen.add(w.title))
    .slice(0, 8)
    .map((w) => ({ title: w.title, uri: w.uri }));
  return { text, sources };
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

async function readSite(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; SocialPlusICP/1.0)", accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 400000);
    return { text: htmlToText(html).slice(0, 5000) };
  } catch { return null; }
}

export function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || "";
  const body = html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
  return [title && `Title: ${title.trim()}`, desc && `Description: ${desc.trim()}`, body].filter(Boolean).join("\n");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
