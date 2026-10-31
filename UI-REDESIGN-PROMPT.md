# THE PROMPT — paste everything below the line to any UI agent

---

You are a senior product designer + front-end engineer. Build me a complete
**visual template** for a production website called **JATIN**. You are
changing the *appearance and information architecture only* — the backend,
its endpoints, its data, and the single shared account are frozen (THE RULES
at the end). Deliver styled HTML/CSS for the pages listed in §2, matching the
existing file layout, production-ready, self-contained.

## 1. What this product is — ONE base, TWO instruments

JATIN is one private platform. It has **one shared base**: one account, one
login, one billing/limit ledger, one provider pool, one deployment. On that
base live **two distinct products**. The website must make that true:
the two products are presented **separately** — own landing pages, own
dashboard surfaces, own nav — while everything underneath stays the same.
Never merge their stories; never duplicate the account.

### Instrument 1 — **FLOW** (the gateway · resale of AI capacity)
The owner holds provider keys (groq, openrouter, google, mistral, tavily,
serper, pollinations) in one pool. Customers get **one API key** serving
three faces:
- **text** — OpenAI-compatible chat; the customer picks the model **by name**
  (real names, e.g. `gemini-2.5-flash` — verified daily against the upstream
  catalog)
- **search** — `model:"search"` → normalized web results
- **image** — `model:"image"` → a JPEG
The owner sets **per-model usage limits** per customer account; every key the
customer issues pools into those numbers, and a grant can never exceed the
pool's real capacity for that model (it is clamped to 30–80% of the pool by
the account's usage). Customers never see which provider serves them —
**opacity is a core brand value**.

### Instrument 2 — **CREW** (agents at work)
"Identical agents in different seats" — Lead · Builders · Auditors · Scribe ·
Scout — run as one process group over an immutable typed event stream per
project. You can start a crew, kill it mid-run (partial work stays; the
attempt is recorded *killed*, never lost), post lines to a **live feed**
(bad lines are rejected live within seconds; the stream never blocks), run a
**cross-check** where a *different provider's* model audits the work
(falsification-first; `unproven` is a first-class state), and a **portfolio**
view that names "the next human decision" per project.

**Brand:** *"Every drop, one pearl."* Sub: *"One base. Two instruments."*
Voice: calm, precise, a little poetic — a jeweller's workbench, not a SaaS
brochure. FLOW's story is **control and opacity**; CREW's story is **labor
and truth**. Different moods, one house style.

## 2. The pages (exactly these six, in this structure)

### A. `index.html` — the house (public)
One short, composed page. Top bar: brand mark (small SVG: concentric arcs +
gold core dot) + wordmark + nav: **Flow** · **Crew** · Sign in.
- **Hero**: display headline in three weights (*thin* "One base," / *bold*
  "two **instruments.**" — one leaning gold-italic word), a live aggregate
  badge (requests 24h + crews running, from the API).
- **The split**: two large panels side by side (stacking on mobile) — left
  **FLOW** ("Every key, one gateway. The providers behind it are not your
  business."), right **CREW** ("The crew works while you decide. Killed,
  never lost."). Each panel: one sentence, one signature visual (Flow: the
  gold key/ledger motif; Crew: the seat roster line), one button into its
  product page. This is the whole point of the page — **two doors, one
  house**.
- **Footer**: brand line, both product names, sign-in link. No more.

### B. `flow.html` — the FLOW product page (public)
- Top bar (same house chrome) with **Flow** active; a "Crew →" link on the
  right.
- **Hero**: *thin* "Every key," / *bold* "one **gateway.**" sub-line about
  one key, three faces, real verified model names.
- **The three faces**: three cards (text · search · image), tiny inline-SVG
  icons, one line each.
- **The call**: a terminal card (mono) showing `curl POST
  /api/flow/chat/completions` with `model:"gemini-2.5-flash"`; caption:
  *the names you see are the real ones — verified against the catalog daily.
  The providers behind them are not your business.*
- **The limits desk** (the owner's control, as a designed mock-up): a
  per-model limits matrix — rows = model names + "all models", columns =
  rpm · tpm · rpd · monthly; small gold chips under model rows
  (`rpm pool 60 · 40 granted elsewhere`); a clamp note in the corner
  (`llama-x rpm: 1000 → 48 — capped to 80% of the pool`).
- **The ledger**: two inline-SVG charts (30-day requests — gold area;
  30-day cost — pearl-blue area) + by-model bars. *"The provider's own
  numbers."*
- CTA band: **Enter the Flow dashboard** (signs in; lands on Flow).

### C. `crew.html` — the CREW product page (public)
- Same house chrome, **Crew** active, "Flow →" link.
- **Hero**: *thin* "The crew works," / *bold* "you **decide.**" sub-line
  about seats over one immutable stream.
- **The seats**: a horizontal roster — Lead · Builders · Auditors · Scribe ·
  Scout — each a quiet card with a small role glyph and one line of what that
  seat falsifies/builds/writes.
- **The feed**: a live-looking terminal pane with typed lines and verdict
  chips (`accepted` green · `falsified` red · `unproven` slate) — one line
  explicitly shows a rejected post: *refused at post, seen in seconds; the
  stream never blocks.*
- **Killed, never lost**: a short two-line panel — kill a run mid-task; the
  partials stay on the board; the attempt is recorded `KILLED`.
- **Cross-check**: one panel — *a different provider's model audits the
  work. Falsification-first; `unproven` is a first-class state.*
- **The portfolio**: one project card mock — open work + *"next for this
  account: decide — <project> — ship or rework"*.
- CTA band: **Enter the Crew board**.

### D. `login.html` — one door (public)
A centred card on the dark grain surface: **Sign in** / **Request access**
tabs (register answers *pending verification by the operator*). One line
under the card: *"One account. Both instruments."* Gold primary button, gold
focus rings, zero marketing clutter.

### E. `dashboard.html` — the app: one shell, two products, three ranks

The single most important redesign: **stop the long scroll-heap.** One
professional application shell:

- **Shell (all views)**: a fixed **left sidebar** — brand mark at top; the
  **product switcher** (two entries: **Flow** and **Crew**, with a tiny icon
  each — this is the one honest place the two products coexist); below, the
  current product's section nav; at the bottom, the account (name + status
  dot + `operator`/`member` badge) + Sign out. **Top bar** per view: view
  title (display 800), one line of context, and ≤2 chips (e.g. active limits,
  crews running). Content area: **one job per screen**, generous spacing
  (8px rhythm, 24–32px gutters), max content width ~1080px, real **tables**
  with hairline rows instead of badge soup, quiet empty states
  (*"no keys yet — issue the first one below"*), consistent loading
  skeletons, errors as one red line under the relevant control.
- **Rank 1 — the member (customer) dashboard.**
  - **Flow → Overview**: four summary cards (requests 30d · tokens 30d ·
    cost 30d · gateway keys) — mono numbers, thin labels; the requests +
    cost charts; recent activity table (time · model · tokens · latency ·
    status).
  - **Flow → Keys**: two labelled groups — *Provider keys* (BYO; rows:
    provider · label · masked key · auto-limit chips · revoke; add form
    without any limit inputs — note *"limits are applied automatically —
    you never type them"*) and *Gateway keys* (rows: name · prefix ·
    requests · cost · last used · revoked · revoke; the **Issue** panel:
    name + model picker (verified names + search + image) → reveal card: the
    key in mono, *shown once*, copy button, ready-to-paste curl using the
    picked model).
  - **Flow → Models**: the account's model list as a **table**: name ·
    status (`✓ verified Oct 31` gold / `checking…` slate) · faces
    (search/image with a `live` chip when available) — one line under:
    *"These are the real model names, checked daily against the catalog."*
  - **Flow → Usage**: full-width charts (requests · cost · by-model bars),
    then **limit windows** as a clean table (scope · kind · used/limit ·
    resets in), then the request ledger table.
  - **Crew → Board**: project select; runs **table** (title · workers ·
    elapsed · status chip running/killed/done · actions kill); the start
    form as a right-hand panel (title · workers 1–8 · run seconds).
  - **Crew → Feed**: left = the live stream (terminal pane, typed lines,
    verdict chips, refused posts visible with the reason); right = the post
    composer (type select · text · raw toggle).
  - **Crew → Portfolio**: one card per project — open work + the *next human
    decision* line, open work outranks green.
- **Rank 2 — the operator (admin) additions** (gated by `isOperator`;
  members never render them):
  - **Flow → Desk** (operator entry in the Flow nav): pending accounts first
    (verify/suspend), then the **accounts table**: account · status · org ·
    gateway keys · 30d usage · [Limits] [Models] [Suspend].
  - **Limits editor** (opens per account, as a full view, not a dropdown
    blob): the per-model matrix as a real table — rows = `all models` /
    `search` / `image` / each model name; columns rpm · tpm · rpd ·
    monthly_tokens · monthly_cost_cents · monthly_images ·
    monthly_searches; under each model row a **pool chip row** (`rpm pool 60
    · 0 elsewhere`); typing above the pool turns that chip red; a save bar
    at the bottom reports clamps (`llama-x rpm: 1000 → 48 — capped to 80% of
    the 60 rpm pool`) and the account's 30-day usage beside it.
  - **Model workbench** (per account): left = existing names as rows (name +
    catalog dot green/gold + rungs `groq/llama-x` + missing-from-catalog
    note); right = the editor: model name (real model names) · rung provider
    · rung model id (datalist from the catalog) · [+ add rung] (max 5, shown
    as an ordered ladder 1–5) · [use model name] · [assign / replace
    ladder]; footer row: [check catalog now] + *last checked: groq · Oct 31*.
  - **Catalog panel** (Flow nav, operator): table per provider — key present
    · last checked · fresh? · model count — + [check all now].
- **Rank 3 — nothing else exists.** No operator UI inside Crew; no crew UI
  inside the member's Flow. Products stay separated inside the app exactly as
  on the site.

### F. (shared) `preloader` — the brand moment
Full-screen dark curtain: a thin gold bar drops, the wordmark slams in
letter-by-letter (line-masked), holds, scatters; the curtain lifts.
**No-JS safe** (no script → content simply visible) and must never strand
the user covered (watchdog reveals).

## 3. The style (exact, non-negotiable tokens)

- **Surfaces**: background `#0B0E1A`. Panels: 3–6% pearl overlays. Hairlines
  `rgba(245,241,232,.14)`.
- **Ink**: text `#F5F1E8` (never pure white); secondary `#9AA3AE`; faint
  `rgba(245,241,232,.55)`.
- **Accent**: gold `#D4AF6A` — the *only* chromatic accent; keep it rare and
  precious (actions, focus, verified badges, chart lines, brand core).
  Status: green `#59C98B` · gold (partial/warning) · `#E08A7A` (error /
  over-pool / suspended) · slate (muted / unknown).
- **Type**: **Bricolage Grotesque** (variable 200–800 — use 200/300 thin,
  400, 800 bold in the same headline; one word may be a leaning gold
  italic). **IBM Plex Mono** for keys, masks, numbers, chips, code, tables'
  data columns. H1/H2: line-height ≤ .95, letter-spacing −0.035em,
  `text-wrap: balance`. Body 17px/1.6, `text-wrap: pretty`. (Fonts are
  self-hosted woff2 — keep the `@font-face` rules as-is.)
- **Texture & light**: fixed full-page **grain** (SVG turbulence, ~5%,
  overlay blend); soft radial **beams** (gold upper-left, pearl lower-right,
  ≤14% alpha); sections meet on a gentle **arch**, not hard rules.
- **Components**: 12–14px radii; hairline borders; mono 10.5–12px badges
  (uppercase tracking for eyebrows); solid-gold primary buttons (dark text),
  ghost secondaries; **tables** with 13px mono data columns, hairline row
  dividers, right-aligned numbers; focus-visible = 2px gold outline, offset
  3px.
- **Layout law (the anti-heap rule)**: one job per screen; sidebar nav, not
  a long scroll; no more than two primary actions visible at once; summary
  cards in rows of 4 max; every list that can be a table is a table;
  whitespace is a feature — the current build is the disease you are curing.
- **Motion**: slow and weighted (600–900ms, power3.out); views fade/rise
  once on entry (no scroll-choreography inside the app); preloader as above;
  **respect `prefers-reduced-motion`** — everything degrades to instant.
- **Charts**: inline SVG only (area + line), gold = requests, `#7FB4E6` =
  cost, mono tick labels. No chart libraries.
- **Overall feeling**: a jeweller's vault that happens to run a data centre —
  dark, warm, quiet, expensive. No gradient text, no glassmorphism blobs, no
  purple, no shadow maximalism, no emoji in chrome.

## 4. The rules (frozen — breaking any of these breaks the product)

1. **Files**: produce exactly `index.html`, `flow.html`, `crew.html`,
   `login.html`, `dashboard.html`, `site.css`, and keep `preloader.js` /
   `preloader.css` working (re-style the curtain; keep the no-JS-safe +
   watchdog behaviour). `flow.html` and `crew.html` are NEW files — they must
   each get **one line** in `apps/api/src/static.ts` (the API host serves the
   same files; without the line they 404 there). Netlify serves anything in
   the folder automatically.
2. **No external anything**: no CDNs, no Google Fonts, no external images.
   Icons = inline SVG; charts = inline SVG; textures = data-URI SVG. The site
   is viewed in a sandbox with **no network**.
3. **The API contract is frozen** (same-origin `/api/*` only — never write an
   API host into a page):
   - auth: `POST /api/auth/login`, `POST /api/auth/register`, `GET
     /api/auth/me`, `POST /api/auth/logout` (cookie session — no
     Authorization header in page code).
   - landing badges: `GET /api/pulse` → `{up,version,uptimeS,requests24h,
     crewsRunning}`.
   - account: `GET /api/account/keys`, `POST /api/account/keys
     {provider,label,secret?}` (limits auto-applied — **no limit inputs in
     the UI**), `POST /api/account/keys/:id/revoke`, `GET
     /api/account/projects`, `GET /api/account/aliases` → `{aliases:
     [{alias,verified,verifiedAt}], services:[{name,available}]}`, `GET
     /api/account/limits`.
   - flow: `GET /api/flow/usage` → `{requests[],keys[],gatewayKeys[],
     orgWindows?(member), series:{days[30],models[]}}`, `POST
     /api/flow/keys {name}` → `{key (once),prefix}`, `GET /api/flow/keys`,
     `POST /api/flow/keys/:id/revoke`.
   - operator: `GET /api/admin/pending`, `POST /api/admin/users/:id/verify`,
     `POST /api/admin/users/:id/suspend`, `GET /api/admin/users`, `GET
     /api/admin/users/:id/limits` → `{org,scopes,limits[],pool,fraction,
     usage30d}`, `PUT /api/admin/users/:id/limits {limits:[{model,kind,
     limit,reservePct}]}` → `{limits[],caps[]}`, `GET
     /api/admin/users/:id/aliases` → `{aliases:[{alias,targets,
     catalog:{status,verifiedAt,missing[]}}]}`, `PUT /api/admin/users/:id/
     aliases {alias,targets}` (≤5), `GET /api/admin/catalog`, `POST
     /api/admin/catalog/refresh`.
   - crew: `GET /api/crew?slug=`, `POST /api/crew`, `POST /api/crew/:runId/
     kill`, `GET /api/crew/:runId`; feed: `GET /api/projects/:slug/stream`
     (SSE) + `POST /api/projects/:slug/stream`; portfolio: `GET
     /api/portfolio`.
   **Do not change any path, body, or field name.** The inline dashboard JS
   keeps reading these exact fields.
4. **Element ids are load-bearing** (the JS drives ~45 of them): keep
   `hello, status-marks, keys, add-key, add-note, gk-keys, add-gk, gk-model,
   gk-note, gk-plain, gk-reveal, gk-copy, gk-curl, gk-usage, reqs, windows,
   usage-chart, alias-list, api-model-note, crew-project, crew-start,
   crew-note, runs, feed-project, feed-post, feed-note, feed, pf-next,
   portfolio, desk-sec, desk, desk-users, limits-sec, org-limits` — or update
   HTML and JS together, atomically. (The new product pages `flow.html` /
   `crew.html` are presentational — free ids there.)
5. **Mode gating**: `GET /api/auth/me` returns `isOperator` — every operator
   surface (Desk, Limits matrix, Workbench, Catalog) renders only for
   operators. Members never receive or display provider names; the API
   already redacts — the UI must not invent.
6. **Dashboard is one HTML file with inline `<script>`** (no build step, no
   framework). You may restructure the JS, but behaviour in §3/§4 is
   preserved 1:1. The sidebar/product switcher navigates *within* the single
   dashboard file (section show/hide + hash), not via separate files.
7. **Separation is presentational only.** No backend, schema, endpoint,
   deploy, or auth change — one account, one session, one pool, exactly as
   today.
8. New page files (if you truly need more) go in the same folder and get one
   line each in `apps/api/src/static.ts`.

## 5. Deliverables

1. The six pages + CSS + the two `static.ts` lines, in the existing layout,
   ready to replace.
2. Keep grain, beams, arches, preloader, focus states, reduced-motion.
3. A `CHANGELOG.md` at the repo root: what changed visually, the new
   two-product IA in one paragraph, and a checklist confirming rules 1–8.
4. Tie-breakers when unsure: **restrained over clever · gold over gradient ·
   mono over sans for anything that is a number · a table over a pile of
   chips · two products, never one.**
