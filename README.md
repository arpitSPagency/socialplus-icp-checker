# Social+ ICP Checker

A one-page tool, hosted free on GitHub Pages. Paste a company website plus any extra details (founder name, LinkedIn About text, notes) and it tells you which tier the lead is and why.

- **Research:** the page reads the website, the LinkedIn company page, StartupIntros, Bing web and news results and a couple of press pages through Jina's free reader (`r.jina.ai`, no key), then Gemini reads the website plus that evidence and reports HQ, headcount (LinkedIn band), funding, segment, decision makers and buying triggers. When the site doesn't link its LinkedIn page, the page works out the company's name (title / copyright line) and searches DuckDuckGo for it: that finds the LinkedIn page and headcount snippets from ZoomInfo, Growjo and similar, and Growjo's own profile is read as a further fallback. Pages found by name only count if they mention the company's domain. Google Search grounding is not used: it returns 429 on a free Gemini key.
- **Tiering:** fixed rules in `public/tiers.js`, not the AI, so the same facts always give the same tier.
- **Editable facts:** if the research gets something wrong, fix it on the page and the tier updates instantly.

## Tiers

| Tier | Rule | Action |
|---|---|---|
| **A** | US / UK / Canada / Australia / UAE / EU **and** Pre-seed/Seed funded, **or** a Series round in the last 12 months, **or** (no known round) up to 50 employees | Pursue |
| **B** | Same markets **and** a Series round older than 12 months, **or** (no known round) 51–200 employees. 200+ = above profile → Nikita sign-off | Pursue |
| **C** | India | India approach |
| **D** | 1–5 person op, transactional, no strategy, or budget < $500/mo (₹40K) | Decline politely, never chase |

Rules are checked in order: **D first** (any country), then **India → C**, then funding stage (a known round beats headcount), then the international size bands. These go to Nikita as borderline: countries outside the list, non-core segments, and unconfirmed headcount or HQ.

To change a rule, edit `public/tiers.js`, run `npm test`, and push.

## Deploy on GitHub Pages

1. **Create the repo.** On github.com/new, name it `socialplus-icp-checker` and set it to **Public**. GitHub Pages is free only for public repos. Your key is not stored in the code.
2. **Push:**
   ```
   cd ~/socialplus/icp-tool
   git remote add origin https://github.com/YOUR-USERNAME/socialplus-icp-checker.git
   git push -u origin main
   ```
3. **Turn on Pages:** repo → **Settings → Pages** → Source: **GitHub Actions**.
4. **Add the key:** repo → **Settings → Secrets and variables → Actions → New repository secret** → Name `GEMINI_API_KEY`, Secret = your key from https://aistudio.google.com/apikey.
5. **Deploy:** repo → **Actions → Deploy to GitHub Pages → Run workflow**. After about a minute the site is at `https://YOUR-USERNAME.github.io/socialplus-icp-checker/`.
6. **Lock the key to your site (important).** The key has to be sent from the browser, so anyone who looks can see it. Restrict it so it only works on your page: https://console.cloud.google.com/apis/credentials → click the key → **Application restrictions: Websites** → add `https://YOUR-USERNAME.github.io/*` → **Save**.

After that, every push to `main` re-deploys automatically.

If the secret isn't set, the page still works. It just asks each visitor for their own Gemini key and saves it in their browser.

## Local development

```
npm test                          # tier rule tests
npx serve public                  # open the page locally (paste your key in the box)
```

## Files

```
public/index.html      page
public/app.js          UI logic
public/gather.js       free web evidence: site, LinkedIn (linked, guessed or found by name), headcount search, Growjo, StartupIntros, Bing RSS, press via r.jina.ai (browser-side)
public/research.js     Gemini call, model fallback, quota/503 handling (browser-side)
public/tiers.js        tier rules (the only place tiers are decided)
public/config.js       key placeholder, filled by the GitHub Action at deploy
.github/workflows/pages.yml
test/tiers.test.mjs
```

## Limits

- LinkedIn's public company page is read through Jina's reader, which usually shows the employee band and HQ. If LinkedIn or Jina blocks a request, the check still runs on the website and search snippets, and the "Double-check" line says so.
- Jina's reader is free without a key but rate-limited per IP (about 20 requests a minute). Each check makes 6 to 8 reader calls, so two checks a minute is fine; a burst is not.
- AI research can be wrong. Check the "Confidence" and "Double-check" lines before outreach.
- Gemini's free tier has rate limits. If you see a rate-limit message, wait a minute.
