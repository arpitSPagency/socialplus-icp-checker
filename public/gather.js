// Free web research material, gathered in the browser before Gemini runs.
//
// Why this exists: on a free Gemini key, Google Search grounding returns 429
// on every model (checked 17 Sep 2026), and Gemini's own url_context tool is
// blocked by every search engine after a few hits. Jina's reader
// (https://r.jina.ai/<url>) needs no key, allows browser calls from any
// origin, and returns clean text for DuckDuckGo result pages, LinkedIn's
// public company page and most press/database sites. So the page fetches the
// pages itself and hands the text to Gemini as evidence.
//
// Everything here degrades: any fetch that fails is simply left out, and the
// caller still gets whatever came back.

export const JINA = "https://r.jina.ai/";
export const DDG = "https://html.duckduckgo.com/html/?q=";
const PAGE_CHARS = 12000;   // cap per page handed to the model
const FETCH_MS = 30000;

// Hosts Jina cannot read usefully (login walls, bot blocks, nav-only pages).
const SKIP = /crunchbase\.com|tracxn\.com|pitchbook\.com|zoominfo\.com|apollo\.io|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|duckduckgo\.com|glassdoor|indeed\.com/i;
// Hosts that usually carry headcount or funding facts. Ranked first.
const PREFER = /linkedin\.com\/company|startupintros|techcrunch|prnewswire|businesswire|globenewswire|wikipedia\.org|growjo|cbinsights|dealroom|eu-startups|sifted|yourstory|inc42|entrackr|finsmes|vcnewsdaily/i;

export async function gather({ url, notes, fetchText = jinaText, onStatus = () => {} }) {
  const host = url ? hostOf(url) : null;
  const person = personIn(notes);
  const queries = [];
  if (host) {
    // Quoted so results must mention the domain, not a similarly named company.
    queries.push({ kind: "linkedin", q: `"${host}" linkedin company` });
    queries.push({ kind: "funding", q: `"${host}" funding round raised` });
  } else if (person) {
    queries.push({ kind: "linkedin", q: `"${person}" founder linkedin company` });
  } else {
    queries.push({ kind: "funding", q: String(notes || "").trim().slice(0, 100) });
  }
  if (host && person) queries.push({ kind: "person", q: `"${person}" ${host}` });

  onStatus("Searching the web…");
  const searches = await Promise.all(queries.map(async ({ kind, q }) => {
    const text = await fetchText(DDG + encodeURIComponent(q)).catch(() => "");
    return { kind, q, text, links: ddgLinks(text) };
  }));

  // Pick pages worth opening: the LinkedIn company page, then up to two
  // funding/press pages, ranked by how likely they are to hold hard facts.
  const picks = [];
  const seen = new Set();
  const add = (l) => { if (l && !seen.has(l.href) && !SKIP.test(l.href)) { seen.add(l.href); picks.push(l); } };
  const li = searches.flatMap((s) => s.links).find((l) => /linkedin\.com\/company\//i.test(l.href));
  add(li);
  const fundingLinks = searches.filter((s) => s.kind === "funding").flatMap((s) => s.links)
    .filter((l) => !SKIP.test(l.href) && !/linkedin\.com/i.test(l.href))
    .sort((a, b) => Number(PREFER.test(b.href)) - Number(PREFER.test(a.href)));
  fundingLinks.slice(0, 2).forEach(add);

  onStatus("Reading LinkedIn, funding pages and press…");
  const pages = await Promise.all(picks.map(async (l) => {
    const text = await fetchText(l.href).catch(() => "");
    return { title: l.title, url: l.href, text: clip(text) };
  }));

  const material = [
    ...pages.filter((p) => p.text.length > 200),
    ...searches.filter((s) => s.text).map((s) => ({ title: `Search results: ${s.q}`, url: DDG + encodeURIComponent(s.q), text: clip(searchDigest(s.text), 6000) })),
  ];
  return { material, sources: pages.filter((p) => p.text.length > 200).map((p) => ({ title: p.title, uri: p.url })) };
}

export async function jinaText(target) {
  const res = await fetch(JINA + target, { headers: { accept: "text/plain" }, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`reader ${res.status}`);
  return await res.text();
}

// DuckDuckGo wraps every result as https://duckduckgo.com/l/?uddg=<encoded>&rut=…
// Jina renders them as markdown links, so pull out title + real target.
export function ddgLinks(md) {
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]{3,200})\]\(https?:\/\/duckduckgo\.com\/l\/\?uddg=([^&)\s]+)[^)]*\)/g;
  let m;
  while ((m = re.exec(md || ""))) {
    let href;
    try { href = decodeURIComponent(m[2]); } catch { continue; }
    if (!/^https?:\/\//.test(href) || seen.has(href)) continue;
    if (/^!\[/.test(m[1]) || /^Image \d/.test(m[1])) continue;
    seen.add(href);
    out.push({ title: m[1].replace(/\*\*/g, "").trim(), href });
  }
  return out;
}

// Strip the link and image markup from a results page so the model just sees
// "title — snippet" lines.
export function searchDigest(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\(https?:\/\/duckduckgo\.com\/l\/\?uddg=([^&)\s]+)[^)]*\)/g, (_, t, u) => { try { return `${t} <${decodeURIComponent(u)}>`; } catch { return t; } })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function personIn(notes) {
  const m = String(notes || "").match(/(?:[Ff]ounder|CEO|CTO|CMO|[Cc]o-founder)[^\n:,]*[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/);
  return m ? m[1] : null;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const clip = (s, n = PAGE_CHARS) => String(s || "").slice(0, n);
