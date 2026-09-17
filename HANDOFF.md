# Social+ ICP Checker — Handoff for Claude Code

Owner: Arpit Arora (Social+). Written 17 Sep 2026.
This is an **independent tool**. Do **not** change the `socialplus-outreach` skill, `/lead`, the
auto-fire-mails pipeline, or any other existing tool because of it. Its tier rules intentionally
differ from the skill.

## What it is

A one-page web tool. Anyone pastes a company **website** (plus optional notes such as a founder name,
LinkedIn About text or budget hints). The page shows the **tier (A/B/C/D)**, the reason behind each
check, flags for Nikita, the facts it found, and sources. Users (Tanisha, Nikita, the team) need no
login and no key.

- **Live URL:** https://arpitspagency.github.io/socialplus-icp-checker/
- **Repo:** https://github.com/arpitSPagency/socialplus-icp-checker (public, branch `main`)
- **Local copy:** `~/socialplus/icp-tool`
- **Hosting:** GitHub Pages, deployed by GitHub Actions on every push to `main`.
- **Cost:** free. Arpit does **not** want to pay for any API.

## Architecture (rebuilt 17 Sep 2026, evening)

```
Browser (static page on GitHub Pages)
  ├─ public/gather.js    → free evidence, no key, all through https://r.jina.ai/<url>
  │                        (CORS-enabled, free, ~20 req/min/IP): the website, the LinkedIn
  │                        company page (slug taken from the site's own LinkedIn link),
  │                        StartupIntros by that slug, Bing web RSS + Bing News RSS, and
  │                        up to 2 press pages whose title names the company
  ├─ public/research.js  → Gemini reads the website (url_context) + that evidence,
  │                        returns FACTS only (JSON). Model fallback, quota/503 handling.
  ├─ public/tiers.js     → fixed rules turn facts into a tier (no AI in this step)
  └─ public/app.js       → UI, editable facts form, manual mode, copy summary
```

**Why the rebuild:** the first version depended on Gemini's Google Search grounding. On this
free key that tool returns 429 on *every* model (verified with direct API calls on 17 Sep), and
`gemini-2.5-*` are retired for new users (404). The page then died on a transient 503 because
anything that wasn't 429/404 was treated as fatal. Gemini's own `url_context` fetcher is also
blocked by every search engine after a few hits, so search-result pages cannot be handed to it
directly. Jina's reader is the piece that works: verified reading `linkedin.com/company/<slug>`
(public view shows "Company size 11-50", HQ), StartupIntros, Wikipedia, Forbes, press, and Bing's
RSS feeds (`bing.com/search?format=rss`, `bing.com/news/search?format=rss`; the JSON reader mode
is needed for RSS). DuckDuckGo through the reader hits a bot challenge within a few requests, so it
is only a last fallback with challenge detection. Brave, Mojeek, Startpage, Google News RSS all fail.
Crunchbase, Tracxn, PitchBook and ZoomInfo come back empty or nav-only and are skipped.

- There is no server. Netlify was tried first and dropped: it was unreliable, and Arpit prefers GitHub Pages.
- The Gemini key comes from the repo secret `GEMINI_API_KEY`. The workflow
  `.github/workflows/pages.yml` injects it into `public/config.js` at deploy time. **Never commit a
  real key.** In the repo, `config.js` must keep `GEMINI_API_KEY = ""`.
- Because there's no server, the key is visible in the deployed page. The only protection is a Google
  Cloud **website restriction** on the key (`https://arpitspagency.github.io/*`). Arpit was told to set it;
  it isn't confirmed yet.

## Files

| File | Purpose |
|---|---|
| `public/index.html` | Page, facts form, Tier guide |
| `public/app.js` | UI logic; manual mode; own-key option (saved in localStorage) |
| `public/research.js` | Gemini prompt + call; modes; model fallback; quota + 503 handling |
| `public/tiers.js` | **The only place tiers are decided** |
| `public/config.js` | Key placeholder + default model (`gemini-3.6-flash`) |
| `public/style.css` | Styles (light/dark) |
| `.github/workflows/pages.yml` | Test → inject key → deploy Pages |
| `public/gather.js` | Free evidence: DDG + LinkedIn + press via r.jina.ai |
| `test/tiers.test.mjs` | 43 tests (`npm test`, Node 22, no deps) |

## Tier rules (set by Arpit, 17 Sep 2026)

Checked in this order:

1. **Tier D: decline, never chase.** This applies in any country when: 1–5 person operation, transactional or no strategy
   (`tiny_operation`), or budget under $500/mo or ₹40K (`low_budget`).
2. **Tier C: India.**
3. **International** (US, UK, Canada, Australia, UAE, EU). **Funding stage beats headcount:**
   - Pre-seed or Seed → **A** (the "dream fit")
   - Series A/B/C… closed within the last **12 months** (`RECENT_MONTHS`) → **A**
   - Series round older than 12 months → **B**
   - Series round with unknown date → **B**, with a flag to add the date
   - No known round → headcount decides: **≤50 → A**, **51–200 → B**
4. **Flags / Nikita sign-off:** 200+ employees (above profile, keeps its tier), countries outside the
   list, non-core segment, unconfirmed HQ or headcount, low research confidence.

Core segments: SaaS, AI-native, DTC/e-commerce, hospitality, real estate, health/fintech, B2B.

To change a rule, edit `public/tiers.js`, add or adjust tests, run `npm test`, then push.

## Gemini handling (free tier)

`research.js`:
- Model order: the configured model, then `FALLBACK_MODELS` (gemini-3.6-flash, 3-flash-preview,
  flash-latest, 3.5-flash-lite, 3.1-flash-lite, flash-lite-latest). All six answered on 17 Sep.
  A "retired / not found" error moves to the next model.
- Modes, in order: `web` (evidence from gather.js + website), `grounded` (Google Search; fails fast
  with 429 on a free key, kept in case Google ever opens it up), `site` (website only; only tried
  when there was evidence to drop).
- Quota (429): short limits wait up to 20s and retry once; otherwise it moves to the next model.
- Busy (500/503/504): wait 4s, retry once, then next model. Never fatal on its own.
- If the reader fetched nothing and grounding didn't run, the "Double-check" line says headcount
  and funding may be from the AI's memory. The prompt also asks the model to label memory-sourced
  numbers and set confidence low.
- If everything fails on quota or network, `app.js` opens the **manual facts form** with a
  "free AI lookup is busy" message, so the user always gets a tier.
- A bad key (400) or website-restriction refusal (403) is shown immediately, with no retry.

- Prose instead of JSON: retry once, then next model (was fatal).
- `gemini-3.6-flash` free quota is 20 requests/day (`generate_content_free_tier_requests`); the
  fallback list absorbs that, and most real checks land on `gemini-3-flash-preview`.

Verified 17 Sep 2026 (evening) from Node and in Chrome:
cal.com → B (LinkedIn 11-50, Series A Apr 2022); lovable.dev → A (LinkedIn 51-200, Stockholm,
Series C Aug 2026, 6 sources, 15s); fyle.in → C (India); mischf.com (a GoDaddy placeholder) →
low confidence, no invented facts.

## Decisions already made (don't reopen without Arpit)

- The input is the website plus pasted notes. **LinkedIn is not scraped** because it needs a login.
- India is in scope for this tool (Tier C), unlike the outreach skill.
- The tool is free-only. **No paid billing.**
- **No key rotation** to get around Gemini limits: same-project keys share quota, and rotating
  across accounts breaks Google's terms.
- **Grok / DeepSeek backup was declined for now.** Both are paid, their keys can't be locked to a website,
  and on a static site the key is public. DeepSeek also has no web search. A second provider would
  need a small server (e.g. a Netlify/Cloudflare function) to hide the key. Build that only if Arpit
  asks.

## Open items / security

1. **Revoke the GitHub token** `icp-checker` (github.com/settings/tokens). It was pasted in chat.
2. **Revoke the xAI key.** It was pasted in chat and is not used anywhere.
3. **Set the Gemini key website restriction.** Checked 17 Sep 2026: it is NOT set. The deployed
   key answers API calls from anywhere (tested with curl, no Referer). Fix at
   https://console.cloud.google.com/apis/credentials → the key → Application restrictions:
   Websites → `https://arpitspagency.github.io/*`.
4. ~~Verify with a real lookup.~~ Done 17 Sep 2026 (see Gemini handling). Re-verify on the live
   URL after the next deploy.
5. The `socialplus-icp-checker` Netlify project is unused and can be deleted.
6. ~~The Tier guide bullets once looked empty in a user copy-paste.~~ Rendered fine on the live page, 17 Sep.
7. **Jina reader dependency.** `r.jina.ai` is free without a key and was reliable during testing, but it
   is a third party. If it starts returning 401/429, `gather.js` degrades to website + AI memory
   (the page says so). A free Jina key would raise the limit but would be public on a static site,
   like the Gemini key; only do that with a key that has no billing attached.

## How to deploy a change

```
cd ~/socialplus/icp-tool
npm test
git add -A && git commit -m "..."
git push origin main          # remote: https://arpitSPagency@github.com/arpitSPagency/socialplus-icp-checker.git
```
`reachforarpit-bit` (the account `gh` is logged in as on this Mac) was added as a collaborator on
17 Sep 2026, and the repo's git config uses `gh auth git-credential`, so `git push` just works. After pushing, check the **Actions** tab for a green "Deploy to GitHub Pages" run, then hard-refresh
the site with Cmd+Shift+R.
