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
//   1. the website          -> text, the company NAME (page title / copyright
//                               line), and the LinkedIn company URL it links to
//   2. LinkedIn company page -> "Company size 11-50", headquarters. Slug from
//                               the site, then guessed from the domain, then
//                               found through a DuckDuckGo search by name
//   3. Headcount search      -> DuckDuckGo "<name>" employees: the snippets from
//                               ZoomInfo, Growjo, RocketReach, Datanyze state a
//                               number ("has 21 employees"). Only when nothing
//                               read so far carries a headcount.
//   4. Growjo                -> employee estimate + funding, keyed by the name;
//                               kept only if the page names the domain
//   5. StartupIntros         -> last round with date, keyed by the LinkedIn slug
//   6. Bing web RSS          -> funding/press pages that name the company; opened
//   7. Bing News RSS         -> funding headlines with dates
//   8. DuckDuckGo            -> funding fallback only if Bing returned nothing
// DuckDuckGo challenges the reader's shared IP after a burst, so it is used
// for at most three requests per check, and any page that only served a bot
// challenge is dropped. The lite endpoint is challenged far less than /html/.

export const JINA = "https://r.jina.ai/";
export const DDG = "https://lite.duckduckgo.com/lite/?q=";
export const GROWJO = "https://www.growjo.com/company/";
const DDG_BUDGET = 3;
export const BING = "https://www.bing.com/search?format=rss&q=";
export const BING_NEWS = "https://www.bing.com/news/search?format=rss&q=";
const PAGE_CHARS = 12000;   // cap per page handed to the model
const FETCH_MS = 30000;

// Hosts the reader cannot read usefully (login walls, bot blocks, nav-only pages).
const SKIP = /crunchbase\.com|tracxn\.com|pitchbook\.com|zoominfo\.com|apollo\.io|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|duckduckgo\.com|bing\.com|glassdoor|indeed\.com|linkedin\.com/i;
// Hosts that usually carry headcount or funding facts. Ranked first.
const PREFER = /startupintros|techcrunch|prnewswire|businesswire|globenewswire|wikipedia\.org|growjo|cbinsights|dealroom|eu-startups|sifted|yourstory|inc42|entrackr|finsmes|vcnewsdaily|forbes|reuters|bloomberg/i;
const CHALLENGE = /complete the following challenge|select all squares|unusual traffic|are you a robot|captcha/i;

export async function gather({ url, notes, fetchText = jinaText, fetchPage = null, onStatus = () => {} }) {
  const host = url ? hostOf(url) : null;
  const person = personIn(notes);
  // Test doubles pass fetchText only; the real page fetch also carries the
  // <title>, which is the best free source of the company's actual name.
  if (!fetchPage) fetchPage = fetchText === jinaText ? jinaPage : async (u) => ({ title: "", content: await fetchText(u) });
  let ddgLeft = DDG_BUDGET;
  const ddg = async (q) => {
    if (ddgLeft <= 0) return "";
    ddgLeft--;
    const t = await fetchText(DDG + encodeURIComponent(q)).catch(() => "");
    if (CHALLENGE.test(t)) { ddgLeft = 0; return ""; }
    return t;
  };
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
  let site = "", title = "";
  if (url) {
    ({ title, content: site } = await fetchPage(url).catch(() => ({ title: "", content: "" })));
    push(`Website: ${host}`, url, site, false);
  }
  const name = companyName({ title, text: site, host, notes });

  // 2. LinkedIn company page. Slug from the site, else from the domain.
  onStatus("Reading LinkedIn…");
  const slugs = [...new Set([linkedinSlug(site), ...(host ? guessSlugs(host) : [])].filter(Boolean))];
  let liUrl = null;
  const tried = new Set();
  for (const slug of slugs.slice(0, 2)) {
    tried.add(slug);
    const u = `https://www.linkedin.com/company/${slug}`;
    const text = await fetchText(u).catch(() => "");
    if (/company size/i.test(text) && (!host || slugMatches(text, host, slug))) { liUrl = u; push(`LinkedIn: ${slug}`, u, text); break; }
  }

  // 3. Headcount by search. "<name>" employees surfaces the LinkedIn page
  // (when the site never linked it and the slug guess missed) and snippets
  // such as "has 21 employees" from ZoomInfo / Growjo / RocketReach. A page
  // found this way must name the domain: "Hiya Health" is also an Australian
  // physio, and only the right one lists hiyahealth.com.
  if (name && (!liUrl || !hasHeadcount(material))) {
    onStatus("Searching for headcount…");
    const queries = [`"${name}" employees`];
    if (!liUrl) queries.push(`site:linkedin.com/company "${name}"`);
    for (const q of queries) {
      if (liUrl && q.startsWith("site:")) break;
      const text = await ddg(q);
      if (!text) break;
      if (!liUrl) {
        const found = mdLinks(text).map((l) => linkedinSlug(l.href)).filter((x) => x && !tried.has(x));
        for (const slug of [...new Set(found)].slice(0, 2)) {
          tried.add(slug);
          const u = `https://www.linkedin.com/company/${slug}`;
          const li = await fetchText(u).catch(() => "");
          if (/company size/i.test(li) && (!host || mentionsHost(li, host))) { liUrl = u; push(`LinkedIn: ${slug}`, u, li); break; }
        }
      }
      const digest = searchDigest(text);
      if (digest && !have(DDG + encodeURIComponent(q))) material.push({ title: `Search results: ${q} (headcount snippets from ZoomInfo, Growjo, RocketReach and similar; check the company name matches)`, url: DDG + encodeURIComponent(q), text: clip(digest, 6000) });
    }
  }

  // 4. Growjo estimates headcount and lists funding, keyed by the plain name.
  // The wrong company comes back for common names, so the page has to
  // mention the domain.
  if (name && host && !hasHeadcount(material)) {
    const u = GROWJO + encodeURIComponent(name.replace(/\s+/g, "_"));
    const text = await fetchText(u).catch(() => "");
    if (/employees/i.test(text) && mentionsHost(text, host)) push(`Growjo: ${name}`, u, text);
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
  // The domain query is precise but misses press that only uses the name
  // ("Hiya" for hiyahealth.com), so the name gets its own query when it
  // differs from the domain.
  const nameQuery = name && name.toLowerCase() !== (stem || "").toLowerCase() && name.toLowerCase() !== (host || "").toLowerCase() ? `"${name}" funding round raised` : null;
  // Bing News ignores boolean queries; plain ones catch each spelling.
  const newsQueries = [...new Set([`${who} funding`, name ? `${name} raises funding` : stem ? `${stem} raises funding` : null].filter(Boolean))];
  const [web, webByName, ...newsParts] = await Promise.all([
    fetchText(BING + encodeURIComponent(webQuery)),
    nameQuery ? fetchText(BING + encodeURIComponent(nameQuery)) : Promise.resolve(""),
    ...newsQueries.map((q) => fetchText(BING_NEWS + encodeURIComponent(q))),
  ].map((p) => p.catch(() => "")));
  const news = newsParts.join("\n\n");
  let links = [...mdLinks(web), ...mdLinks(webByName)];
  let digest = [searchDigest(web), searchDigest(webByName)].filter(Boolean).join("\n\n");
  let digestUrl = BING + encodeURIComponent(webQuery);
  if (!links.length) {
    // 8. DuckDuckGo fallback, dropped when it answers with a bot challenge.
    const d = await ddg(webQuery);
    if (d) { links = mdLinks(d); digest = searchDigest(d); digestUrl = DDG + encodeURIComponent(webQuery); }
  }
  // Open a result only if its title names the company; a quoted domain search
  // still returns "California - Wikipedia" for cal.com.
  const named = new RegExp(`\\b(?:${[stem, person].filter(Boolean).map(escapeRe).join("|")})\\b`, "i");
  // A title that only matches the name ("Maple - Wikipedia" for getmaple.ca)
  // is kept only if the page itself mentions the domain.
  const namedLoosely = name ? new RegExp(`\\b${escapeRe(name)}\\b`, "i") : /$^/;
  const picks = links.filter((l) => !SKIP.test(l.href) && (!host || !sameHost(l.href, host)) && (named.test(l.title) || namedLoosely.test(l.title)) && !have(l.href))
    .sort((a, b) => Number(PREFER.test(b.href)) - Number(PREFER.test(a.href)) || Number(named.test(b.title)) - Number(named.test(a.title)));
  const pages = await Promise.all(picks.slice(0, 2).map(async (l) => ({ ...l, text: await fetchText(l.href).catch(() => "") })));
  pages.filter((p) => named.test(p.title) || !host || mentionsHost(p.text, host)).forEach((p) => push(p.title, p.href, p.text));
  if (digest) material.push({ title: `Search results: ${webQuery}`, url: digestUrl, text: clip(digest, 6000) });
  const newsDigest = searchDigest(news);
  if (newsDigest && !CHALLENGE.test(news)) material.push({ title: `News headlines matching ${who} (check the company name matches)`, url: BING_NEWS + encodeURIComponent(newsQueries[0]), text: clip(newsDigest, 6000) });

  return { material, sources, linkedin: liUrl, name };
}

// "Company size 11-50", "has 21 employees", "21 to 50 employees".
export function hasHeadcount(material) {
  return material.some((m) => /company size\s*\d|\b\d[\d,]*\s*(?:-|–|to)\s*\d[\d,]*\s*employees|\b\d[\d,]*\+?\s*employees\b/i.test(m.text));
}

// The company's name, for search queries. The page <title> ("Cal.com |
// Scheduling Software…") or the copyright line ("© 2026 Hiya Health, Inc.")
// beat the domain stem, which is often a compound ("hiyahealth").
export function companyName({ title = "", text = "", host = "", notes = "" } = {}) {
  const stem = (host || "").split(".")[0];
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const clean = (s) => s.replace(/\s+/g, " ").replace(/^[\s"'“”|:-]+|[\s"'“”|:-]+$/g, "").trim();
  const legal = /,?\s*\b(?:Inc|LLC|Ltd|Limited|Corp|Corporation|GmbH|Pvt|Pty|Co|PLC|S\.?A\.?)\.?$/i;
  const generic = /^(?:home|homepage|welcome|official (?:site|website)|website|login|shop|blog)$/i;
  const cands = [];
  const copyright = String(text).match(/(?:©|\(c\)|copyright)\s*(?:\d{4}(?:\s*[-–]\s*\d{4})?)?\s*(?:by\s+)?([A-Z][A-Za-z0-9&.'’+ -]{1,40}?)(?=\s*(?:,? ?(?:Inc|LLC|Ltd|Limited|Corp|GmbH|Pvt|Pty)\b|\.|,|·|\||all rights|$))/im);
  if (copyright) cands.push(copyright[1]);
  for (const part of String(title).split(/\s*(?:\||—|–|-|:|·)\s*/)) cands.push(part);
  const good = cands.map(clean).map((c) => c.replace(legal, "")).map(clean)
    .filter((c) => c.length >= 2 && c.length <= 40 && !generic.test(c) && !/^https?:/i.test(c) && !/\bmeta\s*ads?\b/i.test(c));
  if (!good.length) return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : person(notes);
  // Prefer the candidate that is the domain (Cal.com), then one that reads as
  // the domain stem (hiyahealth -> "Hiya Health"), then the copyright name,
  // then the shortest title segment.
  const byHost = good.find((c) => host && norm(c) === norm(host));
  const byStem = good.find((c) => stem && norm(c) === norm(stem));
  const chosen = byHost || byStem || (copyright && good[0]) || good.sort((a, b) => a.length - b.length)[0];
  return chosen;
}

function person(notes) { return personIn(notes); }

function mentionsHost(text, host) {
  return new RegExp(host.replace(/\./g, "\\."), "i").test(text);
}

// Jina's JSON mode returns {data:{title,content}} on success and
// {code,message} on failure. The Accept header is CORS-safelisted, so this
// needs no preflight from the page.
export async function jinaPage(target) {
  const res = await fetch(JINA + target, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_MS) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.data?.content) throw new Error(data?.message || `reader ${res.status}`);
  return { title: data.data.title || "", content: data.data.content };
}

export async function jinaText(target) {
  return (await jinaPage(target)).content;
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
