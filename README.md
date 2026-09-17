# Social+ ICP Checker

A one-page tool for the Social+ team. Paste a company website plus any extra details (founder name, LinkedIn About text, notes) and it tells you which tier the lead is and why.

- **Research:** Gemini with Google Search finds HQ, headcount (LinkedIn band), funding, segment, decision makers and buying triggers.
- **Tiering:** fixed rules in `public/tiers.js`, not the AI, so the same facts always give the same tier.
- **Editable facts:** if the research gets something wrong, fix it on the page and the tier updates instantly.
- **No key for teammates:** the Gemini key lives on the server (Netlify), never in the browser.

## Tiers

| Tier | Rule | Action |
|---|---|---|
| **A** | US / UK / Canada / Australia / UAE / EU, up to 50 employees | Pursue |
| **B** | Same markets, 51–200 employees (200+ = above profile → Nikita sign-off) | Pursue |
| **C** | India | India approach |
| **D** | 1–5 person op, transactional, no strategy, or budget < $500/mo (₹40K) | Decline politely, never chase |

Rules are checked in order: **D first** (any country), then **India → C**, then the international size bands. These go to Nikita as borderline: countries outside the list, non-core segments, and unconfirmed headcount or HQ. Core segments are SaaS, AI-native, DTC/e-commerce, hospitality, real estate, health/fintech and B2B.

To change a rule, edit `public/tiers.js`, run `npm test`, and push.

## Deploy (one time, about 10 minutes)

1. **Push to GitHub.** Create a private repo, e.g. `socialplus-icp-checker`, then:
   ```
   git remote add origin https://github.com/<you>/socialplus-icp-checker.git
   git push -u origin main
   ```
2. **Connect Netlify.** app.netlify.com → Add new site → Import from Git → pick the repo. Leave the build command empty. The publish directory is already set by `netlify.toml`.
3. **Add environment variables** (Site configuration → Environment variables):
   - `GEMINI_API_KEY`: from https://aistudio.google.com/apikey
   - `ACCESS_CODE`: leave unset so the link is open to anyone. Set it only if you later want a passcode.
   - `GEMINI_MODEL` (optional): defaults to `gemini-2.5-flash`
4. **Redeploy** (Deploys → Trigger deploy). Share the Netlify URL.

After that, every `git push` to `main` redeploys automatically.

> **Why not GitHub Pages?** Pages only serves static files, so it has nowhere to keep the Gemini key secret. GitHub holds the code and Netlify runs it.

## Local development

```
npm test                  # tier rule tests
npx netlify-cli dev       # runs the page + /api/qualify at localhost:8888
```

For local runs, put `GEMINI_API_KEY=...` in a `.env` file. It's git-ignored.

## Files

```
public/index.html                   page
public/app.js                       UI logic
public/tiers.js                     tier rules (the only place tiers are decided)
public/style.css
netlify/edge-functions/qualify.js   /api/qualify: website read + Gemini research
test/tiers.test.mjs
```

## Limits

- LinkedIn isn't read directly because it needs a login. Headcount comes from search results about the LinkedIn page, or from text you paste into the notes box.
- AI research can be wrong. Check the "Confidence" and "Double-check" lines before outreach.
- Gemini's free tier has rate limits. If you see a rate-limit message, wait a minute.
