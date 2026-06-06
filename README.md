# Salla Segmentation & Journey Dashboard (Arabic)

RFM segments + lifecycle + a 6-stage customer journey + per-segment activation,
for **BUILD_STATION, LIGHTING, HATCH**. Arabic RTL UI for the team. Deploys to
Vercel or Netlify as-is.

```
salla-dashboard/
├── index.html              ← the dashboard (Arabic, render-only)
├── config.js               ← EDIT EVERYTHING HERE (stores, thresholds, labels…)
├── lib/segmentation.js     ← RFM scoring + lifecycle + sample generator
├── lib/salla.js            ← pulls Salla orders, rolls them up per customer
├── api/segments.js         ← Vercel serverless endpoint  /api/segments
├── netlify/functions/segments.js + netlify.toml   ← same endpoint on Netlify
└── vercel.json, package.json
```

The browser **never** sees a token. It calls `/api/segments?store=…`; the function
holds the token (env var) and returns only the computed numbers.

---

## 1. The one file you edit: `config.js`

Everything tunable lives there, commented:

- **STORES** — store ids + the env-var name that holds each token. *(Fill the
  LIGHTING and HATCH `id`s — only BUILD_STATION is pre-filled.)*
- **THRESHOLDS** — every cutoff (New / Active / At-risk / Lapsing / Churned / value tiers).
  Override per store via a `thresholds:{}` block (LIGHTING already has wider windows).
- **PULL** — `lookbackDays`, `perPage`, `maxPages`.
- **FIELD_MAP** — where to read each value inside a Salla order *(verify once, see §4)*.
- **EXCLUDED_STATUS_SLUGS** — defaults exclude `canceled` (American spelling) + refunds.
- **SEGMENTS / JOURNEY / UI** — colours, recommended plays, and all Arabic text.

No other file needs editing for normal tuning.

---

## 2. Deploy

### Vercel
1. Push this folder to a Git repo, **Import** it in Vercel (framework preset: *Other*).
2. **Settings → Environment Variables**, add one per store you have a token for:
   - `SALLA_TOKEN_BUILD_STATION`
   - `SALLA_TOKEN_LIGHTING`
   - `SALLA_TOKEN_HATCH`
3. Deploy. `/api/segments` is live automatically.

### Netlify
1. **Add new site → Import**, build command empty, publish dir `.`.
2. Add the same env vars under **Site settings → Environment variables**.
3. `netlify.toml` already routes `/api/segments` to the function.

#### Access & secrets (set in Netlify → Environment variables)
- `DASH_ACCESS_KEY` — **the dashboard passphrase** viewers must enter (sent as the
  `x-dash-key` header; every `/api/*` function 401s without it). Set/rotate its value only
  in Netlify (never commit it) — viewers are simply re-prompted on the next load.
- `REFRESH_KEY` — protects the refresh endpoints (`x-refresh-key`); set any long random string.
- OAuth (Phase 1 auto-refresh): per store `SALLA_REFRESH_TOKEN_<STORE>` plus
  `SALLA_CLIENT_ID(_<STORE>)` / `SALLA_CLIENT_SECRET(_<STORE>)`; `SALLA_TOKEN_<STORE>` seeds
  the initial access token. Locally, copy these into a git-ignored `.env` for `netlify dev`.

Before any token is set, the dashboard shows **sample data** with a yellow banner —
so you can hand it to the team immediately and switch to live data when ready.

---

## 3. ⚠️ Salla constraints on serverless (read this)

These follow directly from how Salla tokens behave:

- **Refresh tokens are single-use.** This app does **not** refresh inside the request
  path on purpose — concurrent serverless invocations would each try to refresh and
  trigger Salla's parallel-reuse lockout (revokes everything, forces reinstall).
  Keep refreshing in **one** place: your existing Flask OAuth manager, or a single
  scheduled job. That job just needs to keep the `SALLA_TOKEN_*` env values current.
- **IP whitelisting won't work here.** Vercel/Netlify use rotating egress IPs. If you
  have *App Trusted IPs* enabled in the Partners dashboard, either leave it off for
  these read-only scopes, or use the cron option below (your server's fixed IP).
- Access tokens last ~14 days. On expiry the endpoint returns a clear 401 ("refresh
  it"). The dashboard then falls back to sample data rather than breaking.

**More robust option (recommended for BUILD_STATION's volume):** have your Kali server
run `lib/salla.js` on a nightly cron, write the JSON, and host it. The dashboard reads
that instead of calling Salla on each load — fixed IP, one refresh owner, no timeouts.
Say the word and I'll wire that variant.

---

## 4. Verify the order field map (once)

I mapped `FIELD_MAP` to Salla's documented shapes, but confirm against your real
payload. After deploying with a token set, open:

```
/api/segments?store=BUILD_STATION&debug=1
```

It returns one raw order. Check that these resolve and fix `config.js` if not:
`customer.id`, `customer.first_name`, `date.date`/`created_at`,
`amounts.total.amount`, `status.slug`. (The code also tries sensible fallbacks.)

Notes baked in from Salla's behaviour: pagination uses **`totalPages`** (camelCase);
status filter params are ignored so we filter locally by `status.slug`.

---

## 5. Phase 2 (activation)

The **Export** buttons are stubs today. Next step wires them to: create a Salla
**Customer Group** per segment, push hashed audiences to Meta/TikTok/Snap, and
trigger segmented email flows.
