# JATIN

**Every drop, one pearl.** One pool, many models. One crew, many seats.

- **Flow** — an OpenAI-compatible gateway over every provider key an org owns: use-it-or-lose-it quota scheduling, failover with flagged degradation, per-account per-key limits, measured cost.
- **Crew** — identical agents in different seats (Lead · Builders · Auditors · Scribe · Scout) over one immutable stream per project: typed evidence, falsification-first verdicts, `unproven` as a first-class state, bench-replayed environments, one-key join with mandatory falsifiable admission.

Plan: [`PLAN.md`](PLAN.md) — the build baseline. The Operator's crew's plan (canonical), law book, and reference implementation live in [`workspace/`](workspace) and are never shipped in a build context.

## Quickstart (local)

```bash
npm install
cp .env.example .env  # then set:
#   MASTER_KEY     = $(openssl rand -base64 32)
#   JWT_SECRET     = $(openssl rand -hex 32)
#   ADMIN_PASSWORD = $(openssl rand -hex 12)   # your operator login (O3)

npm run db:dev        # embedded Postgres on 127.0.0.1:5432 (keep it running)
npm run db:migrate    # 0001 DDL + 0002 immutable grants (one history, V4 §13)
npm run db:seed       # operator from ADMIN_USERNAME/ADMIN_PASSWORD, org, project, law book v1
npm run dev           # API on :8080 — landing + preloader at /

npm test              # O3 loop + vault law 6.3 (node:test)
npx tsx scripts/check-grants.mts   # the append-only law, verified against the live DB
```

**Two-tier database access** (law 2.2, structural): `DATABASE_URL` is the *owner* role — migrations, seed, tooling. `APP_DATABASE_URL` is the restricted runtime role `jatin_app` — the API hot path connects here, so the append-only grants in migration 0002 bind production behaviour, not just a promise. `Event`, `Verdict`, `LedgerRow`, `Handover`, `Ruleset`, `EnvVersion`, `Breach`, `AuditLog` cannot be UPDATEd or DELETEd by the app.

Auth (O3): `POST /api/auth/register` creates a **pending** account; the operator (env-seeded) verifies from `/api/admin/*`; only then does login work.

## Deploy — the free stack ($0, no credit card, crews live)

| piece | where | free tier (2026) |
|---|---|---|
| site (landing, login, dashboard) | **Netlify** — `apps/web` as-is | unlimited static |
| API (this Fastify app, one container — **crews run here**) | **Render free** — [Dockerfile](Dockerfile) auto-detected, zero config | 512 MB, 750 instance-hrs/mo, no card |
| database (standard Postgres) | **Supabase free** | 500 MB, never expires, pauses after 7 idle days |

**Why Render carries the API:** the crew runner spawns a detached supervisor + worker processes — only a real container can do that. Render's free tier is a real container (no card), so the full feature set is live, including crews and falsification RUN. (The `501` gates for `JATIN_RUNTIME=serverless` exist for function platforms — Render doesn't set it, so nothing is gated.)

**The honest crew physics on the free tier:**
- **512 MB cap** → API (~125 MB peak) + supervisor (~100 MB) + workers (~100 MB each). Run **2–3 workers per crew**, not 8.
- **Render sleeps after 15 min without traffic.** The open dashboard polls `/api/crew` every few seconds, which keeps the instance awake for as long as you're watching the crew (runs cap at 10 min — a crew always survives a watched run). For a headless run, keep the tab open or fire a manual request first.
- **Don't keep it awake with a 24/7 ping** — the free tier caps at 750 instance-hours/month and 24/7 is 744. Sleep it when idle; the wake is ~1 min.
- **Supabase pauses after 7 idle days** — resume in the dashboard (data kept), or a daily uptime ping to the site keeps both the DB and your memory of this fact fresh.

**Steps** (~15 minutes):
1. **Supabase** → new project (region: Singapore for lowest latency from India) → Settings → Database → **Direct connection** → copy the **URI (Session mode)**.
2. **Render** → New → **Web Service** → this repo (the Dockerfile is picked up automatically) → region **Singapore** → env vars:
   - `DATABASE_URL` — the Supabase direct URI (migrations run in the image's CMD at boot)
   - `APP_DATABASE_URL` — same URI (least-privilege `jatin_app` role = later hardening)
   - `MASTER_KEY` — `openssl rand -base64 32`
   - `JWT_SECRET` — `openssl rand -hex 32`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your operator login (bootstrapped at boot)
   - `WEB_ORIGIN` — your Netlify site URL (enables CORS for direct dashboard→API calls)
   Deploy — leave `JATIN_RUNTIME` **unset** so crews are live.
3. **Netlify** → import this repo (no build command — `apps/web` is the publish dir) → replace `RENDER_API_HOST` in [netlify.toml](netlify.toml) with your `onrender.com` URL → deploy. The `/api/*` proxy keeps the dashboard same-origin (direct calls work too — CORS for `WEB_ORIGIN` is built in).
4. Open the site, sign in, add a provider key, start a crew — the whole system, live, at $0.

**CI** (`.github/workflows/ci.yml`) runs on every push to `master`: typecheck · 14 tests against a live seeded Postgres (fresh DB, `migrate deploy` + seed) · **grants gate** (append-only law verified against the live schema, all 32 models classified) · **migrations against a fresh database not named `jatin`** (the Railway trap) · **tree scan** (no caches/binaries/secrets in source, no literal masks in workflow YAML, build context excludes `workspace/` and `.env`).

*Verified, on the record (2026-10-30):* **green** at `cd529cd2` (first green run — all jobs, step-level) · **red** at `26d55cda` (one broken assertion — the gate failed as it must) · **green** at `5139a8d4` (restored). A gate that has gone both green and red is a gate that discriminates.

## Layout

```
apps/web       the static site (landing, login, dashboard) — the shipped vehicle → Netlify
apps/api       Fastify + TS: flow, pool, scheduler, stream, crew, cross-check, portfolio → Render
prisma/        one schema, one migration history (0002 makes the append-only law structural)
workspace/     plans, law book, evidence, reference — NEVER in a build context (.dockerignore)
netlify.toml   site publish + /api/* proxy to the Render API + headers — repo root
Dockerfile     one multi-stage image; Render auto-detects it (migrate deploy in CMD)
```
