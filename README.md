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

## Deploy

**API → Railway** (config in [`deploy/railway.json`](deploy/railway.json) — Nixpacks build, `prisma migrate deploy` on start):
1. Railway → New Project → from this repo. Attach a Railway **Postgres** plugin.
2. Env vars (same as local `.env`):
   - `DATABASE_URL` — the Postgres connection string (owner role; runs migrations).
   - `APP_DATABASE_URL` — same host, **user `jatin_app`, password `jatin_app`** (migration 0002 creates that role and all grants itself). If the platform's Postgres user lacks `CREATEROLE`, run the role block from `prisma/migrations/0002_immutable_grants/migration.sql` in the SQL console once, before the first deploy.
   - `MASTER_KEY` (`openssl rand -base64 32`), `JWT_SECRET` (`openssl rand -hex 32`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `WEB_ORIGIN`, `PORT`.
3. Deploy. `GET /health` should answer before the site points at it.

**Site → Netlify** (config in [`deploy/netlify.toml`](deploy/netlify.toml) — publishes `apps/web`, proxies `/api/*` to the API):
1. Netlify → import this repo; the toml picks the publish dir and the rewrites.
2. The one manual step: edit the `RAILWAY_API_HOST` line in `deploy/netlify.toml` to your Railway domain, commit, redeploy. (Netlify does not interpolate env vars inside `netlify.toml` redirects.)
3. The operator account for the live system is whatever `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set on Railway — register → verify → sign in, same as local.

**CI** (`.github/workflows/ci.yml`) gates every push: typecheck · tests against a live Postgres (seeded) · **grants gate** (append-only law verified against the schema) · **tree scan** (no caches/binaries/secrets in the build context).

## Layout

```
apps/web       static site now (landing, login, preloader) → Next.js at Phase 5 → Netlify
apps/api       Fastify + TS: auth, account/keys, health → Railway
packages/*     core (router/scheduler) · crew (seats/stream/ledger) · evidence · ui
prisma/        one schema, one migration history
workspace/     plans, law book, evidence, reference — NEVER in a build context
deploy/        railway.json · netlify.toml
```
