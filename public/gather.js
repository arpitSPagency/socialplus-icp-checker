// Free web research material, gathered in the browser before Gemini runs.
//
// Why this exists: on a free Gemini key, Google Search grounding returns 429
// on every model (checked 17 Sep 2026), and Gemini's own url_context tool is
// blocked by every search engine. Jina's reader (https://r.jina.ai/<url>)
// needs no key, allows browser calls from any origin, and returns clean text
// for the company website, LinkedIn's public company page, Bing's RSS feeds
// and most press/database sites. So the page fetches the evidence itself and
// hands the text to Gemini.
//
// What is read, in order (each step is optional and degrades on its own):
//   1. the website          -> text, and the LinkedIn company URL it links to
//   2. LinkedIn company page -> "Company size 11-50", headquarters
//   3. StartupIntros         -> last round with date, keyed by the LinkedIn slug
//   4. Bing web RSS          -> funding/press pages that name the company; opened
//   5. Bing News RSS         -> funding headlines with dates
//   6. DuckDuckGo            -> only if Bing returned nothing; it challenges
//                               the reader's shared IP often
// Search-result pages that only served a bot challenge are dropped.

export const JINA = "https://r.jina.ai/";
export const DDG = "https://html.duckduckgo.com/html/?q=";
export const BING = "https://www.bing.com/search?format=rss&q=";
export const BING_NEWS = "https://www.bing.com/news/search?format=rss&q=";
const PAGE_CHARS = 12000;   // cap per page handed to the model
const FETCH_MS = 30000;

// Hosts the reader cannot read usefully (login walls, bot blocks, nav-only pages).
const SKIP = /crunchbase\.com|tracxn\.com|pitchbook\.com|zoominfo\.com|apollo\.io|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|duckduckgo\.com|bing\.com|glassdoor|indeed\.com|linkedin\.com/i;
// Hosts that usually carry headcount or funding facts. Ranked first.
const PREFER = /startupintros|techcrunch|prnewswire|businesswire|globenewswire|wikipedia\.org|growjo|cbinsights|dealroom|eu-startups|sifted|yourstory|inc42|entrackr|finsmes|vcnewsdaily|forbes|reuters|bloomberg/i;
const CHALLENGE = /complete the following challenge|select all squares|unusual traffic|are you a robot|captcha/i;

export async function gather({ url, notes, fetchText = jinaText, onStatus = () => {} }) {
  const host = url ? hostOf(url) : null;
  const person = personIn(notes);
  const material = [];
  const sources = [];
  const have = (u) => material.some((m) => m.url.replace(/\/$/, "") === u.replace(/\/$/, ""));
  const push = (title, pageUrl, text, cite = true) => {
    if (!text || text.length < 200 || have(pageUrl)) return false;
    material.push({ title, url: pageUrl, text: clip(text) });
    if (cite) sources.push({ title, uri: pageUrl });
    return true;
  };

  // 1. Website: evidence in itself, and the way to the LinkedIn page.
  onStatus("Reading the website…");
  let site = "";
  if (url) {
    site = await fetchText(url).catch(() => "");
    push(`Website: ${host}`, url, site, false);
  }

  // 2. LinkedIn company page. Slug from the site, else from the domain.
  onStatus("Reading LinkedIn…");
  const slugs = [...new Set([linkedinSlug(site), ...(host ? guessSlugs(host) : [])].filter(Boolean))];
  let liUrl = null;
  for (const slug of slugs.slice(0, 2)) {
    const u = `https://www.linkedin.com/company/${slug}`;
    const text = await fetchText(u).catch(() => "");
    if (/company size/i.test(text) && (!host || slugMatches(text, host, slug))) { liUrl = u; push(`LinkedIn: ${slug}`, u, text); break; }
  }

  // StartupIntros keys its pages by the LinkedIn slug and states the last
  // round with a date in one line. Kept only if it names the company.
  if (liUrl) {
    const slug = liUrl.split("/").pop();
    const u = `https://startupintros.com/orgs/${slug}`;
    const text = await fetchText(u).catch(() => "");
    if (/has raised|funding rounds?/i.test(text) && (!host || new RegExp(`\\b${escapeRe(host.split(".")[0])}\\b`, "i").test(text))) push(`StartupIntros: ${slug}`, u, text);
  }

  // 4 + 5. Funding: pages from Bing web results, headlines from Bing News.
  onStatus("Searching for funding and press…");
  const stem = host ? host.split(".")[0] : null;
  const who = host ? `"${host}"` : person ? `"${person}"` : `"${String(notes || "").trim().slice(0, 60)}"`;
  const webQuery = `${who} funding round raised`;
  // Bing News ignores boolean queries; two plain ones catch both spellings.
  const newsQueries = [...new Set([`${who} funding`, stem ? `${stem} raises funding` : null].filter(Boolean))];
  const [web, ...newsParts] = await Promise.all([
    fetchText(BING + encodeURIComponent(webQuery)),
    ...newsQueries.map((q) => fetchText(BING_NEWS + encodeURIComponent(q))),
  ].map((p) => p.catch(() => "")));
  const news = newsParts.join("\n\n");
  let links = mdLinks(web);
  let digest = searchDigest(web);
  let digestUrl = BING + encodeURIComponent(webQuery);
  if (!links.length) {
    // 6. DuckDuckGo fallback, dropped when it answers with a bot challenge.
    const ddg = await fetchText(DDG + encodeURIComponent(webQuery)).catch(() => "");
    if (ddg && !CHALLENGE.test(ddg)) { links = mdLinks(ddg); digest = searchDigest(ddg); digestUrl = DDG + encodeURIComponent(webQuery); }
  }
  // Open a result only if its title names the company; a quoted domain search
  // still returns "California - Wikipedia" for cal.com.
  const named = new RegExp(`\\b${escapeRe(stem || person || "")}\\b`, "i");
  const picks = links.filter((l) => !SKIP.test(l.href) && (!host || !sameHost(l.href, host)) && named.test(l.title) && !have(l.href))
    .sort((a, b) => Number(PREFER.test(b.href)) - Number(PREFER.test(a.href)));
  const pages = await Promise.all(picks.slice(0, 2).map(async (l) => ({ ...l, text: await fetchText(l.href).catch(() => "") })));
  pages.forEach((p) => push(p.title, p.href, p.text));
  if (digest) material.push({ title: `Search results: ${webQuery}`, url: digestUrl, text: clip(digest, 6000) });
  const newsDigest = searchDigest(news);
  if (newsDigest && !CHALLENGE.test(news)) material.push({ title: `News headlines matching ${who} (check the company name matches)`, url: BING_NEWS + encodeURIComponent(newsQueries[0]), text: clip(newsDigest, 6000) });

  return { material, sources, linkedin: liUrl };
}

// Jina's JSON mode returns {data:{title,content}} on success and
// {code,message} on failure. The Accept header is CORS-safelisted, so this
// needs no preflight from the page.
export async function jinaText(target) {
  const res = await fetch(JINA + target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_MS) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.data?.content) throw new Error(data?.message || `reader ${res.status}`);
  return data.data.content;
}

// Markdown links from a search page, excluding the engine's own URLs. Bing
// News wraps targets as bing.com/news/apiclick.aspx?...&url=<encoded>.
export function mdLinks(md) {
  const out = [];
  const seen = new Set();
  const re = /\[([^\]]{3,200})\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;
  let m;
  while ((m = re.exec(md || ""))) {
    const href = unwrap(m[2]);
    if (!href || seen.has(href)) continue;
    if (/^!\[/.test(m[1]) || /^Image \d/.test(m[1]) || /^https?:\/\//.test(m[1])) continue;
    seen.add(href);
    out.push({ title: m[1].replace(/\*\*/g, "").trim(), href });
  }
  return out;
}

// DuckDuckGo: https://duckduckgo.com/l/?uddg=<encoded>&rut=…  Bing News:
// …apiclick.aspx?…&url=<encoded>…  Everything else is returned as is.
export function unwrap(href) {
  try {
    const u = new URL(href);
    if (/duckduckgo\.com$/.test(u.hostname) && u.pathname === "/l/") return u.searchParams.get("uddg");
    if (/bing\.com$/.test(u.hostname) && /apiclick/.test(u.pathname)) return u.searchParams.get("url");
    if (/bing\.com$|duckduckgo\.com$/.test(u.hostname)) return null;
    return href;
  } catch { return null; }
}

// Strip link and image markup from a results page so the model sees
// "title <real url>  snippet  date" lines.
export function searchDigest(md) {
  return String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\((https?:\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g, (_, t, u) => { const real = unwrap(u); return real ? (/^https?:\/\//.test(t) ? "" : `${t} <${real}>`) : t; })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function linkedinSlug(text) {
  const m = String(text || "").match(/linkedin\.com\/company\/([A-Za-z0-9][A-Za-z0-9_.-]*)/i);
  return m ? m[1].replace(/[.]+$/, "") : null;
}

// cal.com -> cal-com, cal ; getacme.io -> getacme-io, getacme
export function guessSlugs(host) {
  const h = host.replace(/^www\./, "");
  return [h.replace(/\./g, "-"), h.split(".")[0]];
}

// A guessed slug can land on the wrong company; keep it only if the page
// mentions the domain, or the slug came from the site itself.
function slugMatches(text, host, slug) {
  const stem = host.split(".")[0];
  return new RegExp(host.replace(/\./g, "\\."), "i").test(text) || new RegExp(`\\b${stem}\\b`, "i").test(text.slice(0, 2000)) || slug === host.replace(/\./g, "-");
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sameHost(href, host) {
  try { return new URL(href).hostname.replace(/^www\./, "") === host; } catch { return false; }
}

export function personIn(notes) {
  const m = String(notes || "").match(/(?:[Ff]ounder|CEO|CTO|CMO|[Cc]o-founder)[^\n:,]*[:\s]+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/);
  return m ? m[1] : null;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

const clip = (s, n = PAGE_CHARS) => String(s || "").slice(0, n);
