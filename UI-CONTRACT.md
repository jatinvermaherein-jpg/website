# JATIN — site & API structure (the UI/UX hand-off contract)

**Read this first if you are asked to change only the UI/UX and appearance.**
This document is the map: what exists, what talks to what, and exactly what
must not be touched (or changed in shape) so that the backend keeps working
untouched.

---

## 1. The three pieces (and who owns what)

| piece | where | owns | a UI agent may… |
|---|---|---|---|
| **Site** (static) | Netlify, published from `apps/web` | everything the user *sees* | ✅ change freely |
| **API** (Fastify + TS, one Render container) | `apps/api` | all logic, auth, quota, pool, crew | ❌ never |
| **Database** (Postgres on Supabase) | `prisma/` | data | ❌ never |

The glue: `netlify.toml` proxies `/api/*` **server-side** to
`https://jatin-api.onrender.com/api/*`. The browser stays same-origin the
whole time — no CORS, no API URL in any page. The API also serves the same
static files (see `apps/api/src/static.ts`) so the dashboard works on the
API host too.

```
browser ── same origin ──► Netlify (apps/web: index/login/dashboard/css/fonts)
                              │  /api/* (proxied server-side)
                              ▼
                          Render API (apps/api) ──► Supabase Postgres
```

## 2. The pages (`apps/web/`)

| file | role |
|---|---|
| `index.html` | landing page; live badge fed by `GET /api/pulse` (aggregate stats only) |
| `login.html` | login + register (calls `/api/auth/login`, `/api/auth/register`) |
| `dashboard.html` | **the whole app** — one HTML file, inline `<script>`, ~1100 lines |
| `site.css` | all styling (CSS custom properties: `--jt-gold` etc.) |
| `preloader.js` / `preloader.css` | first-paint animation |
| `fonts/`, `favicon.svg` | self-hosted assets (no CDNs anywhere) |

**The dashboard is the UI.** It has two modes decided by
`GET /api/auth/me`: **operator** (sees the operator desk) and **member**
(cut down, provider names redacted by the API itself). The inline JS is
*frontend logic* — you may refactor/restyle it, but not change what it
asks for or how it reads the answers.

## 3. The API — the UI's entire world

Session = **httpOnly cookie** set by `/api/auth/login` (same origin, no
headers needed). Gateway keys (`jkn_…`) are a *different* credential for
external clients (Bearer); the dashboard only ever *shows* them.

### public (no auth)
| method · path | returns |
|---|---|
| `GET /health` | `{status, db, uptimeSec, ts}` |
| `GET /api/pulse` | `{up, version, uptimeS, requests24h, crewsRunning}` — landing badge |

### auth (session cookie)
| method · path | body / returns |
|---|---|
| `POST /api/auth/register` | `{username,email,password,displayName}` → `{username,status:'pending',note}` |
| `POST /api/auth/login` | `{username,password}` → `{token}` + sets session cookie |
| `GET /api/auth/me` | `{username, isOperator, status, …}` ← **drives every conditional in the UI** |
| `POST /api/auth/logout` | clears the cookie |

### account (any authenticated user)
| method · path | returns (fields the UI reads) |
|---|---|
| `GET /api/account/keys` | `keys[]: {id, provider, category, label, keyMask, status, limits[]:{kind,limit,reservePct}}` |
| `POST /api/account/keys` | `{provider,label,secret?}` → 201 `{id,…}` — **limits auto-applied, never typed** |
| `POST /api/account/keys/:id/revoke` | — |
| `GET /api/account/projects` | `projects[]` |
| `POST /api/account/aliases` | `{alias, targets[]:{provider,providerModelId,priority?}}` (BYO accounts only) |
| `GET /api/account/aliases` | `aliases[]: {alias, verified, verifiedAt, targets?}` + `services[]: {name:'search'\|'image', available}` |
| `GET /api/account/limits` | `orgWindows[]: {kind, model?, used, effectiveLimit, windowEnd, headroom}` |

### admin (operator only — 403 for members)
| method · path | returns |
|---|---|
| `GET /api/admin/pending` | `pending[]: {id, username, createdAt}` |
| `POST /api/admin/users/:id/verify` / `…/suspend` | `{username, status}` |
| `GET /api/admin/users` | `users[]: {id, username, status, isOperator, createdAt, org, gatewayKeys, usage:{requests,costCents}}` |
| `GET /api/admin/users/:id/limits` | `{org, scopes, limits[]:{model,kind,limit,reservePct}, pool{scope: {kind: {cap,elsewhere,…}}}, fraction, usage30d}` |
| `PUT /api/admin/users/:id/limits` | body `{limits[]:{model,kind,limit,reservePct}}` → `{limits[], caps[]:{model,kind,requested,effective,poolCap,note}}` |
| `GET /api/admin/users/:id/aliases` | `aliases[]: {alias, targets[], catalog:{status:'live'\|'partial'\|'unknown', verifiedAt, missing[]}}` |
| `PUT /api/admin/users/:id/aliases` | body `{alias, targets[]}` (max 5 rungs) → `{alias, targets[]}` |
| `GET /api/admin/catalog` | `catalog[]: {provider, hasPoolKey, checkedAt, fresh, count, models[]:{model,lastSeenAt}}` |
| `POST /api/admin/catalog/refresh` | → `{refreshed[]:{provider,models,ok}, morePending}` |

### flow (session **or** `jkn_…` Bearer — one key, three faces)
| method · path | notes |
|---|---|
| `POST /api/flow/chat/completions` | OpenAI-shaped; `model` = an assigned name (member) or `provider/model-id` (operator/BYO); streams SSE |
| `POST /api/flow/search` | `{query, maxResults?}` → `{results[]:{title,url,snippet}, _jatin}` |
| `POST /api/flow/image` | `{prompt,width?,height?}` → **binary `image/jpeg`** (no JSON) |
| `GET /api/flow/usage` | `{requests[], keys[], gatewayKeys[], orgWindows?(member), series:{days[30]:{date,requests,tokens,costCents}, models[]:{model,requests,tokens,costCents}}}` |
| `POST /api/flow/keys` | `{name}` → 201 `{key, prefix, name, note}` — **key printed exactly once** |
| `GET /api/flow/keys` / `POST /api/flow/keys/:id/revoke` | list / revoke |

### crew & projects (the other product surface, all session cookie)
| method · path |
|---|
| `GET /api/crew?slug=…` · `POST /api/crew` · `POST /api/crew/:runId/kill` · `GET /api/crew/:runId` |
| `GET /api/projects/:slug/stream` (**SSE live stream**) · `POST /api/projects/:slug/stream` (post a line) |
| `GET·POST /api/projects/:slug/rows` · `POST /api/projects/:slug/falsify` (cross-check) |
| `POST /api/projects/:slug/seats/:seatId/bench` · `…/resume` |
| `GET /api/portfolio` |

## 4. THE CONTRACT — what a UI-only change must preserve

1. **Do not touch:** `apps/api/`, `prisma/`, `Dockerfile`, `netlify.toml`,
   `.github/`, `scripts/`, `package.json` (root or api).
2. **Same origin, always.** Every `fetch` must keep its `/api/…` path —
   the Netlify proxy and the API's static server make that work on both
   hosts. Never hardcode the Render URL in a page.
3. **Element ids are load-bearing.** The inline JS drives ~45 element ids
   (`hello, status-marks, keys, add-key, gk-keys, add-gk, gk-model,
   gk-plain, gk-reveal, gk-copy, gk-curl, gk-usage, reqs, windows,
   usage-chart, alias-list, api-model-note, crew-project, crew-start,
   runs, feed-project, feed-post, feed, pf-next, portfolio, desk-sec,
   desk, desk-users, limits-sec, org-limits`, plus the dynamic
   `limits-edit-<userId>` / `models-edit-<userId>`). Restyle freely;
   keep the ids (or update both the HTML and the JS together).
4. **Payloads and field names are a contract.** Send the same JSON shapes,
   read the same field names listed in §3. Renaming a response field on
   the API side is a backend change.
5. **Auth is the cookie.** No `Authorization` header in dashboard code.
   `isOperator` from `/api/auth/me` decides which sections render —
   operator-only sections (`desk-sec`) must stay gated that way.
6. **No external CDNs.** Charts are inline SVG; fonts are self-hosted;
   the in-app preview is offline by design. Keep it that way.
7. **New static pages** must be listed in `apps/api/src/static.ts`
   (one line each) so the API host serves them too; Netlify serves
   anything in `apps/web` automatically.
8. **Opacity is enforced by the API, but don't undo it in the UI:** the
   member view never receives provider names — if a field isn't in the
   response, it doesn't exist for members.

## 5. What you may change freely

Colors, typography, spacing, layout, section order, icons, copy,
animations, charts' look (keep them inline SVG), the preloader, the
landing hero — anything cosmetic. As long as §4 holds, the backend works
untouched, and `npm test` (17 tests) stays green as the invariant.

## 6. Smoke test after any UI change

1. Log in as **member** (verified account): landing badge, model list with
   verified badges, issue a gateway key, charts, feed, crew.
2. Log in as **operator**: operator desk (verify/suspend), per-account
   limits matrix with pool chips, model workbench with catalog dots,
   "check catalog now".
3. `GET /api/pulse`, `/health` still answer on both hosts
   (`jatin-live.netlify.app` and `jatin-api.onrender.com`).
