# THE PROMPT — paste everything below the line to any UI agent

---

You are a senior product designer + front-end engineer. Build me a complete
**visual template** for a production website called **JATIN**. You are changing
the *appearance only* — the product's behaviour, endpoints, and data are
frozen (see THE RULES at the end; I will tell you which files exist so you
match the real structure). Deliver styled HTML/CSS for the four pages,
production-ready, self-contained.

## 1. What this product is (so you design the right thing)

JATIN is a private, premium platform that does two things:

1. **The Gateway (resale of AI capacity).** The owner holds provider API keys
   (groq, openrouter, google, mistral, tavily, serper, pollinations) in one
   pool. Customers get **one API key** that serves three faces:
   - **text** — OpenAI-compatible chat, model chosen by *name* (e.g.
     `gemini-2.5-flash` — real model names, verified daily against the
     upstream catalog)
   - **search** — `model:"search"`, normalized web results
   - **image** — `model:"image"`, returns a JPEG
   The owner sets **per-model usage limits** per customer account; every key
   the customer issues pools into those numbers. Customers never see which
   provider serves them — **opacity is a core brand value**. The dashboard
   shows the owner an *operator desk*: verify/suspend accounts, a per-model
   limits matrix with **pool capacity chips** (pool 100 · granted elsewhere 40),
   a **model workbench** (one name → up to 5 provider rungs, catalog
   freshness dots, "check catalog now"), and 30-day **usage charts**.

2. **The Crew (agents at work).** "Identical agents in different seats" —
   Lead, Builders, Auditors, Scribe, Scout — run as one process group over an
   immutable typed event stream per project. You can start a crew, kill it
   mid-run (partial work stays, the attempt is recorded *killed*, never lost),
   post lines to a **live feed** (bad lines are rejected live within seconds;
   the stream never blocks), run a **cross-check** where a *different
   provider's* model audits the work (falsification-first; `unproven` is a
   first-class state), and a **portfolio** view that names "the next human
   decision" per project.

**Brand line:** *"Every drop, one pearl."* Sub-line: *"One pool, many models —
one crew, many seats."* The voice is calm, precise, a little poetic — a
jeweller's workbench, not a SaaS brochure.

## 2. The pages (exactly these four, in this structure)

### A. `index.html` — landing (public, no login)
- Top bar: brand mark (a small SVG: concentric arcs + a gold core dot) + wordmark,
  nav anchors (Flow · Crew · Pricing-ish "The desk" · "Sign in" button).
- **Hero**: giant display headline set in three weights (e.g. *thin* "Every
  key," / *bold* "one **gateway.**" — one word in an *leaning gold italic*),
  a sub-line, a primary button "Enter the dashboard", and a secondary
  "keep scrolling" hint. A **live badge** (from an aggregate API: requests in
  24h + crews running) proves it's alive.
- **Section "The Gateway"**: three "faces" as cards — text / search / image —
  each with a tiny inline-SVG icon and one line. Below: a live-looking
  terminal card (dark, monospace) showing a `curl` that calls
  `POST /api/flow/chat/completions` with `model:"gemini-2.5-flash"` — and a
  one-line note: *the model names you see are the real ones, verified
  against the catalog daily; the providers behind them are not your business.*
- **Section "The limits desk"**: a mock-up of the per-model limits matrix
  (rows = model names + "all models"; columns = rpm · tpm · rpd · monthly;
  small gold chips under each row showing pool capacity). This section sells
  the owner's control.
- **Section "The Crew"**: seats as a horizontal roster (Lead · Builders ·
  Auditors · Scribe · Scout) with tiny role glyphs; a live-feed mock
  (typed lines with verdict chips: `accepted` / `falsified` / `unproven`);
  a kill-switch motif ("killed, never lost").
- **Section "The ledger"**: two mock charts (inline SVG) — 30-day requests
  (gold area) and 30-day cost (pearl-blue area) — "the provider's own
  numbers".
- **Footer**: brand line, tiny legal line, "operator" sign-in link.

### B. `login.html` — login + register (public)
- Centred card on the same dark surface, grain texture, gold focus rings.
- Two tabs: **Sign in** (username + password) and **Request access**
  (username + email + password + display name) — register answers
  *"pending verification by the operator"*. One gold primary button.
  No marketing clutter — this is a door, not a page.

### C. `dashboard.html` — the app (behind login; two modes)
- **Left/top nav**: brand + account name + status dot (`active` / `pending` /
  `suspended`) + "operator" or "member" badge + sign out.
- **Member mode sections** (in order):
  1. **Your keys** — provider keys the account holds (BYO): rows with
     provider · label · masked key · limit chips (rpm 60 · tpm 500k · …) ·
     revoke. Add-key form (provider select, label, secret; note: *"limits are
     applied automatically — you never type them"*).
  2. **Gateway keys** — "keys you hand to your clients". Issue form: name +
     *model picker* (dropdown of the account's verified model names + search
     + image). On issue: a reveal panel — the key in monospace, shown **once**,
     copy button, and a ready-to-paste `curl` sample using the picked model.
     Below: per-key aggregates (requests · tokens · cost · last used · revoked).
  3. **Usage** — 30-day **requests chart** (gold area, inline SVG) + 30-day
     **cost chart** (blue area) + **by-model bars** (name · requests · tokens ·
     cost) + live limit windows as chips (`rpm 3/30 · reset 42s`) + recent
     request ledger rows (model name · tokens · latency · status · degraded).
  4. **The API** — endpoint card `POST /api/flow/chat/completions` + the
     account's model list as badges: name + **✓ verified <date>** badge
     (gold) or "checking…" (slate); service faces `search` / `image` with a
     `live` badge when available.
  5. **Crew** — start form (project select · title · workers 1–8 · run
     seconds) + runs list (status chips: running / killed / done).
  6. **Feed** — project select · type select (message/answer/correction/
     system) · text · raw toggle · post; the live stream below (typed lines,
     verdict chips).
  7. **Portfolio** — every project card: open-work chips + "next human
     decision" line.
- **Operator-only additions** (hidden for members):
  0. **Operator desk** — pending accounts (verify / suspend), then every
     account row: status · org · keys · 30-day usage · buttons [Limits ▾]
     [Models ▾] [Suspend].
     - **Limits editor** (per account): rows = `all models` / `search` /
       `image` / each model name; columns rpm · tpm · rpd · monthly_tokens ·
       monthly_cost_cents · monthly_images · monthly_searches; **pool chips**
       under each model row (`rpm pool 60 · 0 granted elsewhere`); input
       above the pool turns the chip red; save note reports any clamp
       (`llama-x rpm: 1000 → 48 — capped to 80% of the 60 rpm pool`).
     - **Model workbench** (per account): existing names with rungs
       (`groq/llama-x`) + a catalog dot (green = in today's catalog, gold =
       missing/stale) + missing-model notes; form: model name (real model
       names) + rung provider select + rung model id (**datalist fed from the
       catalog**) + [use model name] + [+ add rung] (max 5) + [Assign /
       replace ladder] + [check catalog now] + "last checked: groq · Oct 31".
  8. **Your limits** — the account's own windows (members see this too).

### D. (shared) `preloader` — the brand moment
A full-screen dark curtain: a thin gold bar drops, the wordmark slams in
letter-by-letter (line-masked), holds, scatters; the curtain lifts to reveal
the page. Must be **no-JS safe** (without JS the content is simply visible)
and must never strand the user covered (watchdog timeout reveals).

## 3. The style (exact, non-negotiable tokens)

- **Surfaces**: background `#0B0E1A` (near-black navy). Panels: 3–6% pearl
  overlays. Hairlines `rgba(245,241,232,.14)`.
- **Ink**: text `#F5F1E8` (warm pearl white, never pure white); secondary
  `#9AA3AE`; faint `rgba(245,241,232,.55)`.
- **Accent**: gold `#D4AF6A` — for actions, focus rings, verified badges,
  chart lines, brand core. It is the *only* chromatic accent; keep it rare
  and precious. Status: green `#59C98B` (ok/verified), gold (warning/partial),
  `#E08A7A` (error/suspended/over-pool), slate (muted/unknown).
- **Type**: display face **"Bricolage Grotesque"** (variable 200–800 — use
  200/300 "thin", 400, 800 "bold" in the same headline; one word may be a
  leaning gold italic). Data face **"IBM Plex Mono"** for keys, masks,
  numbers, chips, code, terminal. H1/H2: line-height ≤ .95, letter-spacing
  −0.035em, `text-wrap: balance`. Body 17px/1.6, `text-wrap: pretty`.
  (Fonts are self-hosted woff2 — keep the @font-face rules as-is.)
- **Texture & light**: a fixed full-page **grain** (SVG turbulence, ~5%
  opacity, overlay blend); soft radial **beams** (gold at upper-left, pearl at
  lower-right, ≤14% alpha); sections separated by a gentle **arch** curve,
  not hard rules.
- **Components**: cards with 12–14px radii and hairline borders; chips/badges
  in mono 10.5–12px (uppercase tracking for eyebrows); buttons = solid gold
  (dark text) primary, ghost secondary with hairline border; focus-visible =
  2px gold outline offset 3px.
- **Motion**: slow and weighted (600–900ms, power3.out); sections rise into
  place on scroll; the preloader sequence above; **respect
  `prefers-reduced-motion`** — everything degrades to instant.
- **Charts**: inline SVG only (area + line), gold for requests, `#7FB4E6`
  for cost, mono tick labels. No chart libraries.
- **Overall feeling**: a jeweller's vault that happens to run a data centre —
  dark, warm, quiet, expensive. No gradients-in-the-text, no glassmorphism
  blobs, no purple, no drop-shadow maximalism, no emoji in chrome.

## 4. The rules (frozen — breaking any of these breaks the product)

1. **Files**: produce exactly `index.html`, `login.html`, `dashboard.html`,
   `site.css`, and keep `preloader.js` / `preloader.css` working (you may
   re-style the curtain, keep the no-JS-safe + watchdog behaviour). Fonts
   stay under `/fonts/`, served by path — keep every `@font-face` src.
2. **No external anything**: no CDNs, no Google Fonts, no external images.
   Icons = inline SVG; charts = inline SVG; textures = data-URI SVG. The site
   is viewed in a sandbox with no network.
3. **The API contract is frozen** (same-origin `/api/*` only — never write an
   API host into a page):
   - auth: `POST /api/auth/login`, `POST /api/auth/register`,
     `GET /api/auth/me`, `POST /api/auth/logout` (cookie session — no
     Authorization header in page code).
   - landing badge: `GET /api/pulse` → `{up,version,uptimeS,requests24h,crewsRunning}`.
   - account: `GET /api/account/keys`, `POST /api/account/keys
     {provider,label,secret?}` (limits auto-applied — **no limit inputs in
     the UI**), `POST /api/account/keys/:id/revoke`, `GET
     /api/account/projects`, `GET /api/account/aliases` → `{aliases:
     [{alias,verified,verifiedAt}], services:[{name,available}]}`, `GET
     /api/account/limits`.
   - flow: `GET /api/flow/usage` → `{requests[],keys[],gatewayKeys[],
     orgWindows?(member), series:{days[30],models[]}}`, `POST /api/flow/keys
     {name}` → `{key (once),prefix}`, `GET /api/flow/keys`, `POST
     /api/flow/keys/:id/revoke`.
   - operator: `GET /api/admin/pending`, `POST /api/admin/users/:id/verify`,
     `POST /api/admin/users/:id/suspend`, `GET /api/admin/users`, `GET /api
     /admin/users/:id/limits` → `{org,scopes,limits[],pool,fraction,usage30d}`,
     `PUT /api/admin/users/:id/limits {limits:[{model,kind,limit,reservePct}]}`
     → `{limits[],caps[]}`, `GET /api/admin/users/:id/aliases` → `{aliases:
     [{alias,targets,catalog:{status,verifiedAt,missing[]}}]}`, `PUT
     /api/admin/users/:id/aliases {alias,targets}` (≤5), `GET
     /api/admin/catalog`, `POST /api/admin/catalog/refresh`.
   - crew: `GET /api/crew?slug=`, `POST /api/crew`, `POST /api/crew/:runId/kill`,
     `GET /api/crew/:runId`; feed: `GET /api/projects/:slug/stream` (SSE) +
     `POST /api/projects/:slug/stream`; portfolio: `GET /api/portfolio`.
   **Do not change any path, body, or field name.** The inline dashboard JS
   must keep reading these exact fields.
4. **Element ids are load-bearing** (the JS drives ~45 of them): keep
   `hello, status-marks, keys, add-key, add-note, gk-keys, add-gk, gk-model,
   gk-note, gk-plain, gk-reveal, gk-copy, gk-curl, gk-usage, reqs, windows,
   usage-chart, alias-list, api-model-note, crew-project, crew-start,
   crew-note, runs, feed-project, feed-post, feed-note, feed, pf-next,
   portfolio, desk-sec, desk, desk-users, limits-sec, org-limits` — or update
   HTML and JS together, atomically.
5. **Mode gating**: `GET /api/auth/me` returns `isOperator` — every operator
   section (desk, limits matrix, workbench, catalog) renders only for
   operators. Members must never receive or display provider names; the API
   already redacts, the UI must not invent.
6. **Dashboard is one HTML file with inline `<script>`** (no build step, no
   framework, no TypeScript). You may restructure the JS, but behaviour above
   must be preserved 1:1.
7. New page files (if you truly need one) go in the same folder and get one
   line each in `apps/api/src/static.ts` — otherwise the API host 404s them.

## 5. Deliverables

1. The four pages + CSS, in the existing file layout, ready to replace.
2. Keep the grain, beams, arches, preloader, focus states, reduced-motion
   handling.
3. A short `CHANGELOG.md` at the repo root: what changed visually, and a
   checklist confirming rules 1–7.
4. If you must choose a direction when unsure: **restrained over clever,
   gold over gradient, mono over sans for anything that is a number.**
