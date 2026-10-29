# JATIN

**Every drop, one pearl.** One pool, many models. One crew, many seats.

- **Flow** — an OpenAI-compatible gateway over every provider key an org owns: use-it-or-lose-it quota scheduling, failover with flagged degradation, per-account per-key limits, measured cost.
- **Crew** — identical agents in different seats (Lead · Builders · Auditors · Scribe · Scout) over one immutable stream per project: typed evidence, falsification-first verdicts, `unproven` as a first-class state, bench-replayed environments, one-key join with mandatory falsifiable admission.

Plan: [`PLAN.md`](PLAN.md) — the build baseline. The Operator's crew's plan (canonical), law book, and reference implementation live in [`workspace/`](workspace) and are never shipped in a build context.

## Quickstart (local)

```bash
npm install
npm run db:dev        # embedded Postgres on :5432 (keep it running)
npm run db:migrate    # first migration carries project_id (Phase 0 law)
npm run db:seed       # operator from ADMIN_USERNAME/ADMIN_PASSWORD, org, project, law book v1
npm run dev           # API on :8080 — landing + preloader at /
```

Auth (O3): `POST /api/auth/register` creates a **pending** account; the operator (env-seeded) verifies from `/api/admin/*`; only then does login work.

## Layout

```
apps/web       static site now (landing, login, preloader) → Next.js at Phase 5 → Netlify
apps/api       Fastify + TS: auth, account/keys, health → Railway
packages/*     core (router/scheduler) · crew (seats/stream/ledger) · evidence · ui
prisma/        one schema, one migration history
workspace/     plans, law book, evidence, reference — NEVER in a build context
deploy/        railway.json · netlify.toml
```
