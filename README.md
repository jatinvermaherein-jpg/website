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

**Everything on Netlify** (site + API as functions — config in [`netlify.toml`](netlify.toml)):
1. Netlify → import this repo. Attach **Netlify DB** (managed Postgres; works with any Postgres too — Supabase free tier, Neon, …).
2. **Before the first deploy**, in the Postgres SQL console, create the restricted role with a real password — migration 0002 deliberately creates it *without* one, so if you create it first, 0002 only adds the grants:
   ```sql
   CREATE ROLE jatin_app LOGIN PASSWORD '<openssl rand -hex 24>';
   ```
3. Site env vars: `DATABASE_URL` (owner role), `APP_DATABASE_URL` (user `jatin_app`, your password — the API hot path), `MASTER_KEY` (`openssl rand -base64 32`), `JWT_SECRET` (`openssl rand -hex 32`), `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `WEB_ORIGIN` (= your site URL), and **`JATIN_RUNTIME=serverless`**.
4. Deploy. Migrations run in the build (`prisma migrate deploy`, idempotent) — if the DB is unreachable the build fails loudly.
5. The operator account is whatever `ADMIN_USERNAME`/`ADMIN_PASSWORD` you set — register → verify → sign in, same as local.

**What runs on Netlify — the honest tier:**

| surface | on Netlify | why |
|---|---|---|
| auth, account keys, gateway keys, usage, aliases, stream, bench, portfolio, verdicts (attested) | ✓ full | DB + HTTP only |
| Flow gateway, SSE included | ✓ full | real socket bridge, chunks verified at 150 ms spacing |
| single-call ceiling | 10 s free · 26 s paid | platform limit — fast models fine, slow reasoning models can hit the wall |
| crew runner | ✗ **501 with the reason** | a crew is a process group; a serverless function cannot spawn one |
| falsification RUN | ✗ **501 with the reason** | it spawns a shell; post an attested-not-witnessed verdict instead (the law supports it) |

**Full set on a persistent host** (when crews come back): [`railway.json`](railway.json) at the repo root — same repo, same build, `JATIN_RUNTIME` unset. The two 501s disappear; nothing else changes.

**CI** (`.github/workflows/ci.yml`) runs on every push to `master`: typecheck · 13 tests against a live seeded Postgres (fresh DB, `migrate deploy` + seed) · **grants gate** (append-only law verified against the live schema, all 32 models classified) · **migrations against a fresh database not named `jatin`** (the Railway trap) · **tree scan** (no caches/binaries/secrets in source, no literal masks in workflow YAML, build context excludes `workspace/` and `.env`).

*Verified, on the record (2026-10-30):* **green** at `cd529cd2` (first green run — all jobs, step-level) · **red** at `26d55cda` (one broken assertion — the gate failed as it must) · **green** at `5139a8d4` (restored). A gate that has gone both green and red is a gate that discriminates.

## Layout

```
apps/web       the static site (landing, login, dashboard) — the shipped vehicle → Netlify
apps/api       Fastify + TS: flow, pool, scheduler, stream, crew, cross-check, portfolio → Railway
prisma/        one schema, one migration history (0002 makes the append-only law structural)
workspace/     plans, law book, evidence, reference — NEVER in a build context (.dockerignore)
netlify/functions/  the API itself, on Netlify — _api bridges /api/* into the built Fastify app (SSE intact)
railway.json   API build + start (prisma migrate deploy on start) — repo root, where Railway looks
netlify.toml   site publish + proxy route + headers — repo root
```
