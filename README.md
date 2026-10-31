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

## Deploy — the free stack ($0, no credit card)

Verified October 2026: every host below has a **no-card, non-expiring free tier**.

| piece | host | free tier (2026) | sleeps |
|---|---|---|---|
| site (landing, login, dashboard) | **Netlify** | unlimited static, `apps/web` as-is | never |
| API (this Fastify app, one container) | **Render** | 512 MB, 750 instance-hrs/mo, [Dockerfile](Dockerfile) auto-detected | 15 min idle → ~1 min wake |
| database (standard Postgres) | **Neon** | 3 GiB/branch, auto sleep/wake | ~5 min idle → seconds wake |

**The honest caveats** (all of them are free-tier physics, not app limits):
- **Render sleeps after 15 min without traffic.** An open dashboard polls `/api/crew`, so the instance stays awake while you're looking at it. First visit after a nap costs a ~1 minute cold start.
- **Crews run on Render** (it's a real container — the supervisor spawn works). Two limits to respect: the **512 MB** cap means 2–3 workers, not 8; and a headless crew with *zero* inbound traffic for 15 minutes gets slept on. Run it with the dashboard open, or accept the nap.
- **Neon's free compute sleeps** after ~5 min and wakes in seconds on the first query. Fine for the API's access pattern. (Supabase free is the alternative DB — 500 MB, never expires, but it pauses after 7 idle days and needs a manual resume, and role creation may have to happen in its SQL editor.)
- **If you ever can use a card** (even a zero-balance virtual one): Oracle Cloud Always Free — 2 ARM OCPU / 12 GB in **Mumbai and Hyderabad** — runs the whole stack, 8-worker crews included, forever. Same Dockerfile, zero code changes.

**Steps** (~15 minutes):
1. **Neon** → new project → copy the **direct** (non-pooler) connection string.
2. **Render** → New → **Web Service** → this repo (the Dockerfile is picked up automatically) → region **Singapore** (Neon has one too — lowest latency from India) → env vars:
   - `DATABASE_URL` — Neon direct string (runs migrations at boot)
   - `APP_DATABASE_URL` — same string for now (least-privilege `jatin_app` role = later hardening)
   - `MASTER_KEY` — `openssl rand -base64 32`
   - `JWT_SECRET` — `openssl rand -hex 32`
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your operator login (bootstrapped at boot)
   - `WEB_ORIGIN` — your Netlify site URL
   Deploy. The image's CMD runs `prisma migrate deploy` (loud failure if the DB is unreachable), then the API starts.
3. **Netlify** → import this repo (no build command needed — `apps/web` is the publish dir) → replace `RENDER_API_HOST` in [netlify.toml](netlify.toml) with your `onrender.com` URL → deploy. The `/api/*` proxy redirect is the only wiring; the dashboard stays same-origin.
4. Open the site, sign in, add a provider key — done.

**What does NOT run on this stack:** nothing on principle — every surface works. The two `501` gates (`JATIN_RUNTIME=serverless`) exist for function platforms (Netlify/Vercel) where process spawning is impossible; Render doesn't set it, so everything is live.

**CI** (`.github/workflows/ci.yml`) runs on every push to `master`: typecheck · 14 tests against a live seeded Postgres (fresh DB, `migrate deploy` + seed) · **grants gate** (append-only law verified against the live schema, all 32 models classified) · **migrations against a fresh database not named `jatin`** (the Railway trap) · **tree scan** (no caches/binaries/secrets in source, no literal masks in workflow YAML, build context excludes `workspace/` and `.env`).

*Verified, on the record (2026-10-30):* **green** at `cd529cd2` (first green run — all jobs, step-level) · **red** at `26d55cda` (one broken assertion — the gate failed as it must) · **green** at `5139a8d4` (restored). A gate that has gone both green and red is a gate that discriminates.

## Layout

```
apps/web       the static site (landing, login, dashboard) — the shipped vehicle → Netlify
apps/api       Fastify + TS: flow, pool, scheduler, stream, crew, cross-check, portfolio → Render
prisma/        one schema, one migration history (0002 makes the append-only law structural)
workspace/     plans, law book, evidence, reference — NEVER in a build context (.dockerignore)
Dockerfile     one multi-stage image for any Docker host — Render auto-detects it (migrate deploy in CMD)
netlify.toml   site publish + /api/* proxy to the Render API + headers — repo root
```
