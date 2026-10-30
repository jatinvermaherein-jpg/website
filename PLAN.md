# JATIN — PLAN (final · build baseline)

**Every drop, one pearl.**

> **Canonical plan:** `workspace/plans/V4-PLAN.md` — the Operator's crew (A1 · A3 · Auditor; A4's death passed the §6.6 acceptance test in production).
> **Law:** `workspace/law/LAW-BOOK.md` (v4, 43 rules, enforcement classes). The build team implements the book: STRUCTURAL at the database, GATE in CI/at write time, REVIEW in the audit flow, HONOUR labelled as such.
> **Reference implementation:** `workspace/reference/seat-server.mjs` — the crew's zero-dependency proof of the join protocol (admission before claim; no falsification → `unproven`).
> **Precedence:** Operator directives (below, newest) > V4 > v3. Where V4 and v3 differ, V4 wins. Where two rules collide, that is a defect — file it, don't pick.
> The spec is still receiving additions from the Operator. This file is re-baselined on every intake.

---

## §A — Operator directives that change the build (2026-10-29, final batch)

| # | Directive | Effect |
|---|---|---|
| **O1** | Projects **do not have to use Flow**. A crew project may run on the org's Flow pool, **or its own provider keys, or its own external system.** | Per-project model routing: `source = flow \| project \| external`. Project-owned keys live in the **project vault** (same law as the Flow vault: encrypted, write-only, injected at execution, never in context); their usage lands in the **project ledger**, not the org's Flow pool. Flow stays the org's default; the interlock holds wherever a project routes through it. |
| **O2** | API usage is **account-based, per user, per key** — each user sets **custom limits per key** on their own account. | Every `provider_credentials` row is org-scoped (never pooled across tenants — D3) and carries user-defined per-window limits (`rpm / tpm / rpd / monthly_tokens / monthly_cost`) + reserve %. The scheduler honours user limits first, published tables second, observed 429s third. Dashboard: per-key limit editor + per-key usage (Phase 5). |
| **O3** | Auth is **username + password**, self-created on the website; accounts are **pending until verified by the Operator from the dashboard**. The Operator's own credentials come from **backend env** (`ADMIN_USERNAME` / `ADMIN_PASSWORD`), seeded at startup. | No email anywhere. `users.status = pending → active` (or `suspended`). Login refuses pending accounts with an explicit reason. Admin surface: verification queue, verify, suspend. D2 **CLOSED** by this: signup is open, access is gated by verification. |
| **O4** | The site **preloader** is the AntherBrackets ACT-1 intro from Drive — renamed for Jatin, not the template. The site's display face is therefore **Bricolage Grotesque** (variable 200–800) + **IBM Plex Mono**, both self-hosted, OFL 1.1 — amending V4 §3 (Fraunces/Inter) by operator instruction, cited per law §10. | Shipped in `apps/web/` (preloader.css/js + fonts). The bar drop, the line-masked char-slam (glide `0.62,0.05,0.01,0.99`, slam `0.2,1.4,0.3,1`, power3.out), the hold, the scatter, the curtain — ported from `night/motion.js` mechanics. No-JS safe (the cover is created by JS), reduced-motion path, watchdog reveal. |
| **O5** | **Provider stack, fixed by the Operator (2026-10-29) — supersedes D1's "Big Five".** Text/reasoning: **Google Gemini · Groq · OpenRouter (free models) · Mistral.** Web search: **Tavily · Serper.dev.** Image: **Pollinations** (legacy no-key endpoint). **DeepSeek**: its own API has no free tier and needs a balance (checked Oct 2026), so it is **not** a key-bearing provider — it is reachable for free through **OpenRouter's `:free` models** (no extra key). | Three categories — `text`, `search`, `image` — on `provider_credentials`. Vault law unchanged: every key-bearing provider is encrypted + write-only; Pollinations stores `no-key`. The dashboard's "Add a key" is grouped by category. OpenRouter's free tier is the budget anchor (no card). |

**Decisions now closed:** D1 (superseded by **O5** — provider stack: Gemini · Groq · OpenRouter-free · Mistral + Tavily · Serper + Pollinations; DeepSeek via OpenRouter `:free`, no own key) · D2 (O3) · D3 (hard boundary) · D5 (Netlify + Railway) · D8/D9/D10 (V4). **Standing as recommended, apply unless the Operator objects:** D4 (advisory first, execution per-seat later) · D6 (org env inherited, project overrides by name) · D7 (5 active projects × 20 seats, configurable).

## §B — The system (V4 + O1–O4, condensed)

Two engines, one repo, one site.

**FLOW** — one OpenAI-compatible API over every provider/key an org owns. Use-it-or-lose-it scheduler: hard filter → `urgency = Σ headroom_w / time_until_reset_w` → cost/latency tie-break → 5% reserves → 4-hop failover ladder (degradation always flagged) → adaptive limits → budgets. Honest target 92–97% of spendable quota, shown measured. Usage is per account, per key, per window (O2).

**CREW** — identical agents, different seats (Lead · Builder · Auditor · Scribe · Scout; 10-court default, ≤20 per project; crews↔projects many-to-many — a crew is a team, a project is work). One **stream** per project (+ crew-wide): typed events, monotonic `seq`, **validated at post, failed open on read**, versioned envelope, cursor-addressed (`events?since=N`). The **ledger** is an append-only transition log — current state is the latest entry, counts are derived. Verdicts are `pass | fail | unproven` (D8): PASS requires load-bearing evidence of a typed kind (`repo` | `system-probe`), a **falsification attempt** with output digest, and an **instrument control** (proven able to fail); a witness must have **run** it (digest matched) or it is `attested-not-witnessed` and cannot close a row. On death: 3 missed heartbeats → vacant → auto-commit `wip/<seat>/<ts>` carrying task id + open question + next action → **verdict quarantine** (that seat's verdicts return to `unverified`) → replacement replays the **bench** (declarative environment artifact with digest; the digest rides in every verdict).

**Join (the join spine):** one key `jt_seat_…` (shown once, hash stored) → `POST /seat/join` provisions atomically: identity, **law book version pinned into the session**, generated brief (open asks first, then ledger, blockers, tasks, settled, refusal list + last N falsifications, last few dozen events), worktree (platform holds the git credential; seats hold short-lived scoped tokens; nobody but the platform pushes `main`), vault injection at execution, bench replay, cursor, heartbeat. **Admission is mandatory and falsifiable**: the seat names one thing in the brief it believes is stale; the witness runs that check; a seat that joins and immediately works is a seat nobody checked. Doors: `npx @jatin/seat` · MCP (`@jatin/mcp`) · raw REST — one behaviour, three doors.

**Multi-project:** ≤5 active projects per org; each with its own stream, ledger, law book, vault, bench, model routes (O1); archive = tombstone (never delete); budgets roll up org → crew → project; **portfolio view** ranks projects by cost of delay and names the single next decision only a human can make.

**Security (binding):** envelope encryption (per-record data key, master key in env/KMS); credentials and env **write-only, no read path returns a value in any shape**; env **never** enters a model context (break-glass audited, per invocation); no cross-tenant key routing; every decryption audited; append-only tables have **no UPDATE/DELETE grant** at the database (`events, verdicts, ledger_rows, handovers, rulesets, env_versions, breach`); RLS on every table + CI gate; seats never hold long-lived credentials; agents propose, humans execute.

**Refusals (V4 §16 + law book):** no unencrypted keys · no prompt logging by default · no agent-raised limits · no read path for env values · no estimates-as-measurements · no summary-reading "verification" · no PASS without falsification + proven-able instrument · no twin-to-twin private channels · no auditor fixing what they audit · no second place to post news · no long-lived agent git credentials · **no gate that never goes red**.

## §C — Engineering layer (build team's)

- **Stack:** Node 20 · pnpm→npm workspaces · TypeScript strict · Fastify 5 · Prisma + Postgres (managed on Railway; embedded Postgres for sandbox dev) · Redis (quota windows, heartbeats — Phase 3+) · zod · argon2id · HS256 JWT (node:crypto) · AES-256-GCM envelope vault (node:crypto) · Tailwind 4. (Next.js 15 ruled a future option, 2026-10-30 — the static dashboard is the shipped vehicle; see Phase 5 status.)
- **Repo:** `apps/web` (Netlify) · `apps/api` (Railway) · `packages/core` (router/scheduler/quota/adapters) · `packages/crew` (seats/stream/tasks/ledger/handovers/bench) · `packages/evidence` (verdict validation/digests/controls) · `packages/ui` · `prisma/` · `workspace/` (plans, law, evidence — **never in a build context**; CI scans for it).
- **Event vocabulary (envelope v1):** `message | answer | correction | task | verdict | ledger | presence | git | env | ruleset | seat | brief | admission | waiver | breach | bench | system`. The wedge evidence is law: the vocabulary must cover the moves agents actually make (answering, correcting, admitting) **from day one**; one malformed event never stops the journal; rejections are telemetry (same refusal reason twice = schema defect).
- **Eventual model (Phases 5+):** the crew room, dashboard, command deck, portfolio, vault UI, seat editor, law-book view, docs — all server-rendered from the stream and ledger. STATE is generated; EVIDENCE narratives are legal.
- **CI gates (positive reporting, 5.5):** typecheck · tests · **grant/RLS gate** (append-only tables have no UPDATE/DELETE for the app role — fails otherwise) · **tree scan** (law 4.5: no caches/binaries/secrets/workspace in build context) · **envelope fuzz** (malformed write rejected at post; read stays open) · provider contract tests (daily, Phase 4). Every gate prints `PASS <name> <count> <timestamp>`.
- **Deploy:** Railway — `railway.json` (repo root), start `prisma migrate deploy && node dist/server.js`, env `DATABASE_URL APP_DATABASE_URL MASTER_KEY JWT_SECRET ADMIN_USERNAME ADMIN_PASSWORD WEB_ORIGIN PORT`; app role `jatin_app` (no UPDATE/DELETE on append-only; created WITHOUT a password — the operator sets one before first deploy). Netlify — `apps/web` (static = shipped vehicle), `/api/*` proxied via `netlify/functions` reading `API_ORIGIN`. Rollback rehearsed once by someone who didn't write it.

## §D — Phases (V4 §13, binding)

| # | Phase | Acceptance (reproducible by a stranger) |
|---|---|---|
| 0 | Foundations | `project_id` in the first migration · one page · one endpoint 200 · seeded row read back · **O3 auth loop: register → pending → operator verify → login** |
| 1 | Flow passthrough | one provider, streaming, real token counts |
| 2 | Multi-key pool | kill a key mid-run, request survives, failover recorded |
| 3 | Quota scheduler | load test proves soonest-reset-first, with numbers |
| 4 | Multi-provider | Big Five adapters; degradation flagged in the response |
| 5 | Dashboard | add key → set per-key limits (O2) → request → see usage → revoke → locked out · web app: static shipped (Next.js ruled a future option, 2026-10-30) |
| 6 | Stream + evidence | one stream, cursor, validate-at-post; bad-line verdict **rejected**; no-falsification verdict **unproven**; no-control instrument **unproven** |
| 7 | Crew runner | agents execute real tasks; kill one mid-task, work finishes |
| 8 | Cross-check | auditor on a different provider catches a planted bug the builders missed |
| 9 | Interactive | human posts, sees a live rejection in the feed within seconds |
| 10 | Bench + fidelity | seat resumes from manifest in one command; a `production` row refuses a `local-stack` verdict |
| 11 | Multi-project | two projects isolated; a pass in one cannot satisfy the other; portfolio names the next human decision |
| 12 | Stunning | design pass per §B's definition of stunning |

**Phase 0 status (this build):** repo scaffolded · full Prisma schema with `project_id` in the first migration · embedded Postgres dev DB · Fastify API (health, O3 auth loop, admin verification, per-key limits + vaulted key add) · landing page with the AntherBrackets-derived preloader (O4) · CI gates · seed (operator from env, org, project, law book v1 pinned).

**Phases 1–12 status (this build, 2026-10-29):** all delivered and committed, 13/13 acceptance tests green, typecheck clean, grants gate holding (tests run as `jatin_app`).
1. **Flow passthrough** — `POST /api/flow/chat/completions`, OpenAI-compatible, SSE + tee'd real usage, per-attempt Request rows.
2. **Multi-key pool** — 401/403 → dead, 429/5xx → 60s cooldown, request survives, failover recorded.
3. **Quota scheduler** — use-it-or-lose-it `urgency = Σ headroom/time-to-reset`, reserves, structured 429 + `retry_after_s`, measured headroom on the read side.
4. **Multi-provider** — org alias ladder (≤4 hops, cross-provider), degradation flag in header + body + row (`x-jatin-degraded`), cost from Model prices, alias API.
5. **Dashboard** — add key (O5 providers, per-key limits) → request → usage (live windows + ledger) → revoke (archive-not-delete, instant lockout) → crew board → live feed → portfolio. **Decision (2026-10-30, audit M6): the static dashboard is the shipped vehicle** — it satisfies the flow acceptance, and the plan's wording is corrected to match the tree. Next.js 15 remains a tracked future option (build-command + rewrite move in `netlify.toml` say so), not debt.
6. **Stream + evidence** — one typed stream per project (envelope v1, 16-event vocabulary), validate-at-post (malformed refused, never written), fail-open read (corrupt flagged), cursor, verdict law: no falsification → `unproven`, no instrument control → `unproven`.
7. **Crew runner** — one crew = one process group; kill = SIGTERM → 5.5s grace → SIGKILL to the group; kill mid-task keeps partials on the board and records exactly one KILLED attempt.
8. **Cross-check** — the witness RUNS the falsification + control with digests (`POST /projects/:slug/falsify`); row resolution derived on read: witnessed decides, a control that fails to fail poisons its verdict, an attested claim never closes a row. Acceptance proven with a planted off-by-one: builder (groq) claims, auditor (openrouter) catches, row FAILS.
9. **Interactive** — refusals are telemetry (well-formed `system` event per refusal; same reason twice = countable), live feed on the dashboard (2s poll, raw mode, rejected/corrupt styling).
10. **Bench + fidelity** — `LedgerRow.environment` (migration 0003); the ladder only runs UP (production rows refuse local-stack/staging verdicts); digest-sealed manifest; resume in ONE command (tampered manifest → 409).
11. **Multi-project** — isolation proven (a pass in one project cannot satisfy the other; org walls 404); portfolio resolves every project through the cross-check law and names the next human decision (open work outranks ship).
12. **Stunning** — design pass: de-rectangularized language carried across all pages (pills, arches, beams, ripples, grain), live `/api/pulse` on the landing (aggregate telemetry only), refusal list in the footer, row hover-lifts, scroll-reveal sections (reduced-motion + failsafe respected), login drop-mark.

**Independent audit (2026-10-30, Auditor seat) — responded in full.** The audit found the CI gate had never run before the branch-trigger fix, a literal `***` committed in the workflow, a hardcoded database name in 0002, and a tree-scan that never checked the folder it named. All addressed and verified on the record: **green** CI at `cd529cd2` · **red** at `26d55cda` (deliberate break — the gate discriminates) · **green** at `5139a8d4`. See README → Deploy for the current deploy runbook (root `railway.json`, password-less `jatin_app` role with operator-set password, Netlify `API_ORIGIN` proxy).

## §E — Open items

1. **D4** — advisory-first confirmation (default applied; crew execution unlocks per-seat when said).
2. **D6/D7** — defaults applied (org env inheritance; 5×20 caps); object and they change.
3. **Operator's env credentials** — `ADMIN_USERNAME/ADMIN_PASSWORD` are seeded from backend env; the sandbox pair is in the dev `.env` (told to the Operator in-chat), Railway pair set at deploy.
4. **The spec keeps landing** — every intake re-baselines this file; additions are appended, never overwritten (law 2.2).
