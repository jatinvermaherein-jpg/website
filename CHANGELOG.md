# CHANGELOG — the two-instrument redesign

## What changed visually

The whole surface was rebuilt around one law: **one job per screen**. The old
dashboard was a long scroll-heap; it is now a professional application shell.
The public site now has **six pages** with a consistent house style
(dark `#0B0E1A`, pearl `#F5F1E8`, one gold accent `#D4AF6A`, Bricolage
Grotesque + IBM Plex Mono, grain + beams + arches, slow weighted motion,
`prefers-reduced-motion` respected throughout).

- **`index.html`** — the house. One hero (*thin* "One base," / *bold* "two
  instruments."), live badges from `GET /api/pulse` (requests 24h, crews
  working), then **the split**: two large panels, left **FLOW** (gold ledger
  tick-line motif) and right **CREW** (the five-seat roster), each one
  sentence, one signature visual, one button into its product page.
- **`flow.html` (NEW)** — the FLOW product page: hero, the three faces
  (text · search · image), **how a client uses your key** (issue → point any
  OpenAI-compatible client at `/api/flow` → call by name, with curl / JS /
  Python tabs), the limits desk (per-model matrix mock with pool chips + the
  80→30% clamp note), the ledger (30-day requests/cost SVG charts + by-model
  bars), CTA band.
- **`crew.html` (NEW)** — the CREW product page: hero, the five seats (Lead ·
  Builders · Auditors · Scribe · Scout, each a quiet card), the live feed mock
  (verdict chips `accepted` / `falsified` / `unproven`, one refused post),
  "Killed, never lost", "Cross-check" (falsification-first), the portfolio
  mock (the next human decision per project), CTA band.
- **`login.html`** — centred card, **Sign in / Request access** tabs, gold
  focus rings, one line under the card: *One account. Both instruments.*
- **`dashboard.html`** — the app, rebuilt as **one shell**:
  - fixed **left sidebar**: brand, the **product switcher** (Flow / Crew with
    glyphs — the one honest place the two coexist), the current product's
    section nav, account block (name + status dot + operator/member badge) +
    Sign out.
  - **top bar** per view: title (display 800) + one context line + chips.
  - **views are hash-addressed** (`#flow/overview`, `#flow/keys`,
    `#flow/models`, `#flow/usage`, `#flow/desk`, `#flow/limits/:id`,
    `#flow/models/:id` → workbench, `#flow/catalog`, `#crew/board`,
    `#crew/feed`, `#crew/portfolio`) — one job per screen, each view fades in
    once.
  - **Member (Flow)**: Overview (greeting, status marks, 4 summary cards,
    30-day charts, recent-activity table), Keys (provider/pool table + add
    form *without* limit inputs for the operator; gateway-keys table + issue
    panel with the once-only reveal + ready-to-paste curl), Models (real-name
    table with verified badges + service faces), Usage (charts, limit windows
    table, per-gateway-key table, full request ledger).
  - **Operator (Flow)**: Desk (pending table first, then the accounts table
    with Limits / Models / Suspend — Limits and Models open as **full
    views**, not dropdown blobs), the Limits matrix as a real table (rows =
    all models / search / image / each model; columns = rpm · tpm · rpd ·
    tok/mo · cost¢/mo · img/mo · search/mo; pool chips under each model row;
    over-pool typing flags the chip red; sticky save bar reports clamps),
    the Model workbench (two panes: assigned names table with catalog dots +
    rung chain, and the ladder editor with the catalog-fed datalist,
    "use model name", ordered rungs 1–5, "check catalog now"), and the
    Catalog panel (per provider: key present · last checked · fresh · model
    count + "check all now").
  - **Crew (all ranks)**: Board (runs table + start form in a sticky side
    panel, partials kept under their rows, kill button), Feed (stream pane +
    post composer with raw toggle), Portfolio (the account-level next
    decision line + the projects table).
  - **Rank 3**: nothing else exists — no operator UI inside Crew, no crew UI
    inside the member's Flow. Separation inside the app matches the site.
- **`site.css`** — the full design system: tokens, house bar styles, hero,
  two doors, product-page sections (faces, terminal card, steps, code tabs,
  matrix, ledger, CTA band), login card, and the shell (sidebar, top bar,
  views, real tables with hairline rows and mono data columns, summary stat
  row, form panels, key reveal, feed pane, charts, limits matrix, workbench,
  catalog, save bar, empty states, reduced-motion).
- **`preloader.js` / `preloader.css`** — untouched in behaviour (no-JS safe,
  watchdog reveal); same brand tokens.
- **`apps/api/src/static.ts`** — two new lines: `/flow.html`, `/crew.html`
  (the API host serves them too; without the lines they 404 there).

## The two-product IA, in one paragraph

JATIN is presented as **one base, two instruments**. The index is the house
with two doors; FLOW (the gateway — control and opacity, gold) and CREW (the
seats — labor and truth, pearl) each get their own public page and their own
dashboard surface behind the sidebar's product switcher. Underneath, nothing
is duplicated: one account, one session, one limit ledger, one provider pool,
one deployment. The switcher is the only place the two products coexist.

## Rules checklist (1–8)

1. ✅ Files: `index.html`, `flow.html`, `crew.html`, `login.html`,
   `dashboard.html`, `site.css`; `preloader.js`/`preloader.css` behaviour
   kept; `flow.html` + `crew.html` each got one line in `apps/api/src/
   static.ts`.
2. ✅ No external anything — inline SVG icons/charts, data-URI grain,
   self-hosted fonts only.
3. ✅ API contract untouched — same-origin `/api/*`, no path/body/field
   renamed; page code never writes an API host (samples use
   `https://<your-gateway>` placeholders).
4. ✅ Load-bearing ids kept and driven by the rewritten inline script
   (hello, status-marks, keys, add-key, add-note, gk-keys, add-gk, gk-model,
   gk-note, gk-plain, gk-reveal, gk-copy, gk-curl, gk-usage, reqs, windows,
   usage-chart, alias-list, api-model-note, crew-project, crew-start,
   crew-note, runs, feed-project, feed-post, feed-note, feed, pf-next,
   portfolio, desk-sec, desk, desk-users, limits-sec, org-limits) — HTML and
   JS updated together, atomically, in this commit.
5. ✅ Mode gating via `GET /api/auth/me` → operator surfaces (Desk, Limits,
   Workbench, Catalog, pool keys) render only for operators; members never
   receive or display provider names (API redaction respected).
6. ✅ Dashboard is one HTML file with inline `<script>`, no build step, no
   framework; the sidebar/switcher navigates within the single file
   (section show/hide + hash).
7. ✅ Separation is presentational only — no backend, schema, endpoint,
   deploy, or auth change.
8. ✅ Any new page would live in the same folder with one `static.ts` line;
   the only new pages are `flow.html` and `crew.html`, both wired.
