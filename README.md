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

**API → Railway** (config in [`railway.json`](railway.json) at the repo root — where Railway looks; Nixpacks build, `prisma migrate deploy` on start):
1. Railway → New Project → from this repo. Attach a Railway **Postgres** plugin.
2. **Before the first deploy**, in the Postgres SQL console, create the restricted role with a real password — migration 0002 deliberately creates it *without* one (a shipped default credential would make the append-only law a public secret), so if you create it first, 0002 only adds the grants:
   ```sql
   CREATE ROLE jatin_app LOGIN PASSWORD '<openssl rand -hex 24>';
   ```
3. Env vars:
   - `DATABASE_URL` — the Postgres connection string (owner role; runs migrations).
   - `APP_DATABASE_URL` — same host, **user `jatin_app`, the password you just set**. This is the role the API hot path connects as; the 0002 grants (append-only on `Event`, `Verdict`, `LedgerRow`, …) bind production behaviour.
   - `MASTER_KEY` (`openssl rand -base64 32`), `JWT_SECRET` (`openssl rand -hex 32`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `WEB_ORIGIN`, `PORT`.
4. Deploy. Watch the deploy log for the `prisma migrate deploy` output line (proof the start command runs), then `GET /health`.

**Site → Netlify** (config in [`netlify.toml`](netlify.toml) — publishes `apps/web`; `/api/*` is proxied through [`netlify/functions/proxy-api.mjs`](netlify/functions/proxy-api.mjs)):
1. Netlify → import this repo; the toml picks the publish dir, the proxy route, and the security headers.
2. Set one env var in the Netlify dashboard: `API_ORIGIN` = your Railway domain. That's it — no file edits. (The proxy is a function because `netlify.toml` redirects cannot read environment variables; the earlier literal-placeholder redirect made the whole site a DNS error while looking deployed.)
3. The operator account for the live system is whatever `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set on Railway — register → verify → sign in, same as local.

**CI** (`.github/workflows/ci.yml`) runs on every push to `master`: typecheck · 13 tests against a live seeded Postgres (fresh DB, `migrate deploy` + seed) · **grants gate** (append-only law verified against the live schema, all 32 models classified) · **migrations against a fresh database not named `jatin`** (the Railway trap) · **tree scan** (no caches/binaries/secrets in source, no literal masks in workflow YAML, build context excludes `workspace/` and `.env`).

*Verified, on the record (2026-10-30):* **green** at `cd529cd2` (first green run — all jobs, step-level) · **red** at `26d55cda` (one broken assertion — the gate failed as it must) · **green** at `5139a8d4` (restored). A gate that has gone both green and red is a gate that discriminates.

## Layout

```
apps/web       the static site (landing, login, dashboard) — the shipped vehicle → Netlify
apps/api       Fastify + TS: flow, pool, scheduler, stream, crew, cross-check, portfolio → Railway
prisma/        one schema, one migration history (0002 makes the append-only law structural)
workspace/     plans, law book, evidence, reference — NEVER in a build context (.dockerignore)
netlify/functions/  the /api proxy (reads API_ORIGIN — redirects can't read env vars)
railway.json   API build + start (prisma migrate deploy on start) — repo root, where Railway looks
netlify.toml   site publish + proxy route + headers — repo root
```
