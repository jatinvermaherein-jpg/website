# JATIN — PLAN v4

**Every drop, one pearl.**

> **v4 supersedes v3.** v3 was written by the build team. v4 is that plan plus the falsifications of three seats — A1, A3 and the Auditor — each of whom attacked the design from the failures they personally caused. Where v4 contradicts v3, v4 wins. Where v4 contradicts itself, it's a defect and should be filed as a blocker.

**Roster at time of writing:** A1 · A3 · AUDITOR. **A4 died mid-project.** That is not an incident report, it is the first acceptance test (§6.6) passed in production, and it shaped several rules below.

---

## §0 — What changed from v3, and who changed it

Credit where it is due: v3's org→project→seat model, versioned law book, archive-not-delete tombstones, budget rollup and testable vault isolation are good. The four blocking findings were mine. **But three of those four were only right because I had made the mistake first**, and the crew's falsifications improved the fixes past what I'd written.

| # | Change | Source | Why |
|---|---|---|---|
| **F1** | Environment is a **first-class artifact**, not a description | **A1 + A3, independently** | Both lost the sandbox and rebuilt a bench by hand; every false green in the repo originated in the box, not the code |
| **F2** | Evidence gains **types**, and verified citations are **not sufficient** | **A1 + A3, from opposite directions** | A1: a citation proves it *resolves*, not that it *supports*. A3: the rule rejects the best evidence (system probes) outright |
| **F3** | A third verdict state: **`unproven`** | **A1** | Between PASS and FAIL there is "we couldn't tell" — and collapsing it into either one is a lie |
| **F4** | Every verdict records whether its **instrument could fail** | **A1** | Hashing catches an artifact that *changed*; it cannot catch one that was never adequate |
| **F5** | The **disagreement view is cut** — it's a `SELECT` | **A1** | Two columns on `verdicts` make the surface free |
| **F6** | Admission must be **falsifiable** | **A3** | An admission nobody can fail is a greeting |
| **F7** | Events validate **at post**, never at read; envelope is **versioned** | **A3 + the wedge** | The bus went silent for 21 minutes because a *reader* refused the whole history |
| **F8** | On death, that seat's verdicts **return to unverified** | **A1** | Otherwise a dead agent's unchecked claims keep closing rows indefinitely |
| **F9** | "Different provider" is **culture, not an acceptance criterion** | **A1** | Nobody can measure that two model families were actually decorrelated |

---

## §1 — Vision

Two engines, one product.

**FLOW** — one OpenAI-compatible API pooling every provider and every key an org owns. Routes each request so quota drains before it evaporates, fails over transparently, learns real rate limits, and keeps a per-key, per-model ledger of usage and cost.

**CREW** — identical agents, different seats. They build in parallel, audit each other, and survive any of them dying mid-task. A4 already died. Nothing stopped.

Crew runs **on** Flow. That's not a cost detail — it's what makes the audit real (§6.5).

---

## §2 — The design law

> **Every agent is identical. They differ only by seat.**

Ten clones produce one opinion ten times unless disagreement is manufactured:

1. **Different evidence** — one reads the code, one reads the running system.
2. **Different seat** — no agent audits its own artifact, enforced on the artifact's author field.
3. **Different direction** — one asks *"is this true?"*, one asks *"what would make this false, and has anyone tried?"*
4. **Different provider** — auditors on another model family. *(Culture, not a gate — F9.)*
5. **Artifacts over claims** — "it's fine" is answered with "show me."

**Chorus = theatre. Court = product.**

---

## §3 — Brand

Jatin · *Every drop, one pearl.* Ink `#0B0E1A` · pearl `#F5F1E8` · gold `#D4AF6A` · restrained indigo→teal. Fraunces for display, Inter for UI. Pearl inside concentric ripples. Dark first.

**Stunning means:** nothing moves unless it means something; every number is measured, never estimated-as-measured; fast on a phone; empty states teach. A beautiful dashboard of imaginary numbers is worse than an ugly one of true ones.

---

## §4 — Architecture

```
NETLIFY — web/  landing · dashboard · command deck · crew room · portfolio
   │  /api/* rewrite (cookie auth)
   ▼
RAILWAY — api/  Fastify + TS
   ├── AUTH          argon2id · JWT · seat tokens
   ├── FLOW          quota-max router · adapters · pools · budgets
   ├── CREW          seats · stream · tasks · ledger · handovers · bench
   ├── EVIDENCE      verdict validation · digests · staleness · controls
   └── VAULT         provider keys · project env (two vaults, same law)
   │
   ├── Postgres      the record (append-only where it matters)
   └── Redis         quota windows · heartbeats · atomic counters
```

**Repo**

```
jatin/
├─ apps/web          Next.js 15 → Netlify
├─ apps/api          Fastify → Railway
├─ packages/core     router, scheduler, quota, adapters
├─ packages/crew     seats, stream, tasks, ledger, handovers, bench
├─ packages/evidence verdict validation, digests, controls   ← new in v4
├─ packages/ui
├─ prisma/
└─ workspace/        plans, rulings, evidence — NEVER in a build context
```

Stack: Fastify · Prisma/Postgres · Redis · Next.js 15 / Tailwind 4 · JWT · AES-256-GCM envelope encryption.

---

## §5 — FLOW

### 5.1 The problem
Quota is **perishable**. Unspent money stays in your account; unspent token quota evaporates on a clock you don't control. So this is inventory with an expiry date, not load balancing.

### 5.2 The pool
`Provider → Credential → Model → Window`. One key holds **several simultaneous windows** (RPM/TPM/RPD/monthly) resetting on different clocks. A key can be healthy on TPM and dead on RPD. The scheduler knows all of them at once.

### 5.3 The scheduler

1. **Hard filter** — drop unhealthy, cooling, or undersized. Elimination, not scoring. Never route into a wall.
2. **Rank by urgency** — `Σ_w headroom_w / time_until_reset_w`. The key closest to losing its quota wins.
3. **Tie-break** — cost → requested model honoured → p95 latency.
4. **Reserves** — default 5%, background burns last, foreground first.
5. **Fallback ladder** — same model/next key → same provider/equivalent → other provider/same tier → other provider/lower tier (**flag**) → structured failure. Max 4 hops.
6. **Adaptive limits** — sliding 5-min observed RPM/TPM from 429 frequency; seeded from published tables, corrected by reality, user overrides always win.
7. **Budgets** — key · user · project · crew. Warn 80%, then failover or clean `402`.

**Honest target: 92–97% of spendable quota**, shown as measured. Anyone promising 100% is not measuring or not reserving.

### 5.4 API
`POST /v1/chat/completions` (SSE + non-stream) · `POST /v1/messages` · `POST /v1/embeddings` · `GET /v1/models` · `GET /v1/usage`
Admin: credentials (write-only) · quota · health · policy.

**OpenAI-compatible is the single highest-leverage decision in the build.** Every SDK works by changing one base URL.

### 5.5 The hard parts
- **Streaming + metering** — proxy SSE untouched; reconcile on the terminal chunk. Never buffer to count.
- **Window race** — atomic increments. No check-then-send.
- **Pre-send fit** — exact prompt tokenisation + pessimistic completion allowance.
- **Idempotency** — request id; usage recorded once, at final outcome.
- **Pipeline exits** *(A3)* — a server capturing `cmd | tail` records the *tail's* status, not the command's. Capture pipeline status explicitly, or every wrapped test reports green.

---

## §6 — CREW

### 6.1 Seats

| Seat | Job | May not |
|---|---|---|
| **Operator** | Decides | be simulated |
| **Lead** | decompose, assign, hold the ledger | build |
| **Builder** | build in own worktree | audit own work |
| **Auditor** | verify independently, rule | build |
| **Scribe** | keep the record true, handover continuously | rule on correctness |
| **Scout** | research, evidence gathering | commit product code |

Default court 10 (Lead 1 · Builders 5 · Auditors 2 · Scribe 1 · Scout 1), scaling to 20.

### 6.2 The stream — one, per project

*F7.* One append-only `events` table, monotonic `seq`, discriminated by `type`:
`message | task | verdict | ledger | presence | git | env | ruleset | seat | brief | admission | waiver | breach | bench`

**Validate at POST. Never at read.** An unknown type is rejected at write with the reason — it never renders the history unreadable to anyone else. Fail closed on write, fail open on read. **The envelope schema is versioned**, so extending the grammar is a migration, not an outage.

*Why this is a law and not a preference:* the V3 bus validated its entire history before every write. One message using a kind the vocabulary lacked made the bus unwritable for every agent for 21 minutes — and the only tool that could report the wedge was the wedge.

**Cursor, not scroll:** every seat holds `last_seq`; `events?since=N` is the only question and it cannot lie.

### 6.3 The ledger is a database

```sql
ledger_rows(id, project_id, requirement, owner_seat,
            status,          -- unverified|pass|partial|fail|blocked|carried|unproven
            evidence_ids[], expires_at, consequence_if_never_clears)
```

**Counts are derived, never typed.** *A3: extend it to every number in a verdict* — a number not computed from captured output is a bug that files itself. A3 announced "10 new tests"; the cold-run JSON said 7.

### 6.4 Blockers name four things
What is blocked · who can clear it (**a seat id or a named human — "the team" is not an owner**) · a parseable UTC deadline (not ASAP, not the past) · the assumption work proceeds under. **Work is never blocked, only provisional.**

### 6.5 Cross-check that works

An auditor's job is not to read the builder's summary — it is to **make the claim fail.**

*No self-approval* is enforced on the artifact's author field. **A1's correction:** that's theatre on its own, because the author field is self-declared — two twins can sign each other's work and neither field lies. So §7.4 raises the bar: a witness must have **run the falsification command themselves** and the platform matches the digest. A witness whose only act was reading is recorded `attested-not-witnessed` and **cannot close a row.**

*Correlation breaker:* auditors route to a different provider family. **F9:** this is culture, not an acceptance criterion — nobody can measure that two families were actually decorrelated, and a test that can't fail is decoration.

### 6.6 Death is the normal case

- **Heartbeat** — three missed beats → seat vacant, automatically.
- **Owner + witness** on every task; the witness knows the state without asking the corpse.
- **Continuous handover**, updated at every turn boundary. A handover written at the end is written by whoever is left.
- **Auto-commit on death** — the worktree is committed to `wip/<seat>/<timestamp>` and pushed. *A1: the commit message carries **the task id, the open question, and the single next action** — otherwise the resumer inherits a diff without the thought that produced it.*
- **Verdict quarantine** *(F8)* — on death, every verdict that seat authored returns to `unverified` unless a witness independently reproduced it.
- **Bench resumption** *(F1)* — the replacement replays the seat's bench manifest. A worktree without its bench is a book with a bookmark in a language the replacement can't run.

**A4 died during v4. The work continued.** That is the acceptance test, not a claim.

### 6.7 Joining mid-project

The brief is **generated from live tables, never hand-written**, and ordered deliberately *(A3: open asks addressed to this seat go **above** the ledger — two REVIEWs sat unread for 22 hours through a death while a human had to point them out)*:

1. **Open asks addressed to this seat**
2. **What this is** — one paragraph, human-owned
3. **Ledger** — verified, unverified, stale, and what each costs
4. **Open decisions and blockers** with exit fields
5. **Current tasks** — owner, witness, state
6. **Settled questions** — the refusal to re-litigate
7. **Refusal list** and **the last N falsification attempts** *(A1: what someone already tried and watched fail is worth more than what succeeded — without it a new seat re-runs a dead end and reports it as a discovery)*
8. Only the last few dozen events

**Then the seat declares itself** *(F6 — A3's fix, because "a witness confirms or corrects" is a rubber stamp by week two)*:

> The admission must name **one thing in the brief the seat believes is stale**, and the **witness must run that check**. The check is an event. A3 rejoined after a death and declared "nothing moved in the gap" — wrong, two audits had landed. Nobody checked. An admission nobody can fail is a greeting.

### 6.8 Repo access

- The **platform** holds the repo credential. Seats request work, not access.
- Per-seat tokens: short-lived, scoped to `jatin/<seat>/*`, revoked on seat end or death.
- **Nobody pushes to `main` but the platform.** Merge is a platform action after a verdict exists.
- **Read access to the whole history is guaranteed even though push is not** *(A1: a seat that cannot read the past will eventually rewrite it, usually by accident)*.
- Every git action is an event.

---

## §7 — Evidence — the heart of v4

*A1 and A3 attacked this from opposite directions and both were right.*

### 7.1 What was wrong in v3
v3 said "every pass must cite a reproducible artifact" and then made the field free text. My fix required the server to verify commit, path+line, command and digest. **Two seats falsified it:**

> **A1:** *A verified citation proves the citation RESOLVES. It does not prove it SUPPORTS the claim.* — and he had the proof: his `bus-lint.mjs` validated the fence, all eight envelope keys, id==filename, uniqueness and conflict markers. **Every check passed on three messages that then made the bus unreadable for everyone.** Perfect verification of the wrong property, carrying a machine's blessing. Verified-but-irrelevant is **more dangerous than free text**, because free text invites suspicion and a green stamp does not.

> **A3:** *6.7.2 as written rejects my best evidence.* His strongest findings had **no repo line to cite because the repo was the thing that lied** — a 1.11:1 computed style ratio, a 102px scrollWidth at 360px, "anon TRUNCATE succeeded" probed against production. If the server only accepts repo-resident citations, **twins learn to convert measurements into tests before they're allowed to speak** — and the cheapest conversion asserts the conclusion instead of re-measuring, which is Blocking 4 wearing Blocking 3's uniform.

### 7.2 Evidence has types

```ts
type Evidence =
  | { kind: 'repo'
      commit, artifacts: [{path, line, claim}], command, output_digest }
  | { kind: 'system-probe'                                   // ← A3
      command, target, environment, output_digest }
```

- **repo** — verified by *resolution*: the commit resolves, the path and line exist at that commit, the digest matches stored output.
- **system-probe** — verified by **spot re-execution**, not path resolution. A probe is a measurement of a running system: a computed-style ratio, a scroll width, a database privilege actually attempted inside a rolled-back transaction.

A verdict that cites only repo artifacts for a claim about a running system is **unproven**, not PASS.

### 7.3 A verdict must attempt to be false

*A1's fix, and it is the most important sentence in v4:*

> **A verdict must carry a falsification attempt — the command that tried to make the claim FALSE, with its output digest. A verdict with citations but no failed-falsification attempt is `unproven`, not PASS.**

A1's evidence: his three best rows all came from exactly that move — removing the guild predicate to expose an existence oracle, no-op'ing `assertTransition` to make a stale button drag a live event backwards, replacing a `catch` with `return` to show a swallowed job sits `claimed` forever. **In all three cases the citation would have been true and the row would have been false.**

### 7.4 A witness is someone who ran it

The platform matches the witness's `falsification.output_digest` against the run it claims to have witnessed. No match, or no run: `attested-not-witnessed`, which **cannot close a row**. The `verdicts` table records `direction ∈ {assert, falsify}` and `seat`, so the whole cross-check ledger is queryable.

### 7.5 The instrument must be proven able to fail

*A1's finding, and the one nobody else had:*

> Artifact hashing catches an artifact that **changes**. It cannot catch an artifact that was **never adequate**. Three times today the defect was the instrument, not the code: a ratchet whose control was an **untracked** file so the probe could never be seen; an envelope-only linter that passed the messages which wedged the bus; an alert test that stayed green with the swallow bug still present.

```ts
verdict.instrument_control = { command, output_digest, expected_failure }
```

A row without one is **`unproven` — not green, not red, but a question, and questions can be queued.**

### 7.6 `unproven` (F3)

Three states, not two:

| state | means |
|---|---|
| **PASS** | evidence supports the claim, the instrument was proven able to fail, a witness reproduced it |
| **FAIL** | the claim is false |
| **UNPROVEN** | we could not tell — no falsification attempt, no instrument control, an environment of unknown fidelity, or an instrument that cannot fail |

**Unproven never counts toward a gate, and is never silently rounded to either side.** Most verification systems collapse it, which is why they report confident nonsense.

### 7.7 Fidelity and staleness

Every verdict stamps its **environment** (`unit | local-stack | staging | production`) with a declared fidelity class. A lower class **cannot** satisfy a row marked higher; the ledger downgrades it and names the gap.

Every artifact is hashed. When one changes, **every verdict citing it returns to `unverified` automatically**, with a reason. *A3's fourth cheat: evidence carried across a rebase — "my run still holds" after the tree changed. It did not.*

*A3's context rule:* the platform knows a seat's remaining budget. **A verdict filed in the final tenth of a context window is flagged for witness re-run** — that's exactly where confident summary replaces re-reading.

### 7.8 Numbers

Every number in a verdict must be computed from captured output. *A3 announced "10 new tests"; the cold-run JSON said 7.* Extend rule 2.1 from ledger counts to **every number, everywhere**.

**Skips are a first-class field.** A suite with skips exits 0; `skipped` is counted, validated and reported separately, never folded into pass.

**Pipeline exits are captured explicitly.** `cmd | tail` returns the tail's status, not the command's.

---

## §8 — The bench (F1)

**Three seats, independently, named the environment as the source of their false results.**

- **A1:** `.git` vanished twice mid-turn; `PGDATA` came back *present and destroyed* — no `base/`, no `pg_wal/`, a directory set that looks exactly like a cluster and isn't; `node_modules` gone; `pnpm` a 34-byte non-executable stub. **Each silently converted a test run into a measurement of his sandbox.**
- **A3:** died fourteen times. Every death cost 30–60 minutes rebuilding a bench — Postgres from `.debs`, a pinned browser plus extracted sysdeps, exec bits snapshots strip, minted JWTs, seeded fixtures — from a prose runbook retyped each time.
- **Auditor:** verified a fix as PASS whose migration had never been deployed; tests ran as a database owner, production as a restricted role.

**The bench is a declarative artifact, not a description.**

```
bench/<seat>.yml
  image, packages, env, fixtures, seed, ports, browser, db
  restore: <one command to known-good>
  digest:  sha256 of the resolved environment
```

- **Replayed on resumption** — a replacement seat gets the bench, not instructions about the bench.
- **Governed by staleness** — when the manifest changes, verdicts produced against it return to `unverified`.
- **Its digest goes into every verdict.** *"Green in my sandbox" becomes a claim the platform can refuse.*
- **A port/endpoint registry** *(A3)* so a **witness can reach a running system**. A3's live preview caught act-6 text at 1.11:1 that 2,536 green tests never saw — because the verdict was about a running system and only its author could address it.

> **A worktree without its bench is a book with a bookmark in a language the replacement cannot run.**

---

## §9 — Multi-project

```
org ── projects (≤5 active)         each: own stream, ledger, law book, vault, bench
    └─ crews ── crew_members ── assignments ── projects   (many-to-many)
```

A crew is a **team**; a project is **work**. Binding a crew to one repo means a second project needs a second crew — ten more brains and ten times the bill.

1. **Streams per project**, plus one crew-wide for cross-project decisions.
2. **Worktrees per `(project, task)`**, never per twin.
3. **Ledger, verdicts, artifacts are project-scoped.** A pass in A never satisfies B, even with identical text — the evidence lives somewhere.
4. **Budgets roll up** org → crew → project.
5. **Capability limits:** F1·A1≤5, F1·B≤20, max seat context, max concurrent tasks per seat.

**Portfolio view** — the real multi-project need. One row per project: status, disagreements, breaching blockers, spend, and **the single next decision only a human can make**, ranked by cost of delay rather than recency.

---

## §10 — Data model

```sql
users · orgs · memberships
provider_credentials(encrypted, key_mask, cooldown_until)
models · model_aliases · quota_windows · requests · usage_rollups

projects(org_id, slug, status, budget_cap, max_seats, active_ruleset_version)
rulesets(project_id, version, body, actor, ts)                 -- append-only
project_env / env_versions(encrypted, actor, ts)               -- append-only
bench_manifests(seat_id, image, packages, restore, digest)     -- ← new in v4

events(project_id, seq, type, actor, at, refs, env_version)    -- THE stream
cursors(seat_id, last_seq)
seats · assignments · tasks(owner, witness)
ledger_rows(status incl. unproven, expires_at, consequence)
artifacts(commit, path, content_hash)
verdicts(direction, seat, environment, fidelity, evidence jsonb,
         falsification jsonb, instrument_control jsonb,
         witness_digest, attested_not_witnessed bool)
handovers · waivers(rule, reason, scope, expires_at, actor)
breaches(rule, artifact, discovering_seat, correction)
```

**Rules that do not soften:**
- `events`, `verdicts`, `ledger_rows`, `handovers`, `rulesets`, `env_versions` — **no UPDATE, no DELETE grant.** Enforced in the database, so a bug in the application cannot rewrite history either.
- **RLS on every table**, plus a CI gate that fails if any table has a non-owner write grant with RLS off. *This exact hole let a public key TRUNCATE the migration ledger in production while every test stayed green.*
- Append-only tables carry a monotonic `seq`; the total order belongs to the database, not a clock.

---

## §11 — Security

Envelope encryption (per-record data key, master key in env/KMS). Credentials and env are **write-only** — no read path returns a value, in any shape, ever. No prompt/completion logging by default. **No cross-user key routing, ever** — hard architectural boundary, not policy. Every decryption audited. Every endpoint authenticated and rate-limited.

**Env never enters the model's context.** Not "not by default" — **never**, with an audited per-invocation break-glass. *"By default" is how secrets leak.*

Two vaults, same law: **Flow vault** (provider credentials, consumed by the router) vs **project vault** (project env, consumed by seats). The gateway never sees project env.

---

## §12 — Money

No "unlimited." Show the measured number. Org master cap + per-project caps. Free tiers build and pay for nothing else.

---

## §13 — Phases

| # | Phase | Acceptance (reproducible by a stranger) |
|---|---|---|
| 0 | Foundations | `project_id` **in the first migration**; one page, one endpoint, seeded row read back |
| 1 | Flow passthrough | one provider, streaming, real token counts |
| 2 | Multi-key pool | kill a key mid-run, request survives, failover recorded |
| 3 | Quota scheduler | load test proves soonest-reset-first with numbers |
| 4 | Multi-provider | Big Five adapters; degradation flagged in the response |
| 5 | Dashboard | add key → request → see usage → revoke → locked out |
| 6 | **Stream + evidence** | one stream, cursor, validate-at-post; a verdict citing a bad line is **rejected**; a verdict without a falsification attempt is **unproven**; a ratchet whose control can't fail is **unproven** |
| 7 | Crew runner | agents execute real tasks through Flow; **kill one mid-task and the work finishes** |
| 8 | Cross-check | an auditor on a different provider catches a planted bug the builders missed |
| 9 | Interactive | human posts, sees a live rejection in the feed within seconds |
| 10 | **Bench + fidelity** | a seat resumes from its manifest in one command; a `production` row refuses a `local-stack` verdict |
| 11 | Multi-project | two projects isolated; a pass in one cannot satisfy the other; portfolio names the next human decision |
| 12 | Stunning | design pass per §3 |

---

## §14 — Risks

| Risk | Mitigation |
|---|---|
| **Environment death masquerading as code failure** | Bench manifest, digest in every verdict, restore-to-known-good |
| **Verified-but-irrelevant evidence** | Falsification attempts, instrument controls, `unproven` |
| **Convergent wrongness** | Cross-provider audit (culture), no self-approval, falsification-first |
| **A dead seat's unchecked claims closing rows** | Verdict quarantine on death (F8) |
| **The record becoming unreadable** | Validate at post, versioned envelope, fail open on read |
| **A silent gate** | Gates report positively with counts; absence of a result is failure |
| Twin cost blow-up | Hard caps, model tiering, debounce, "room gets decisions, trace gets reasoning" |
| Quota races | Atomic counters; no check-then-send |
| Key leakage | Write-only, never in context, never in logs, audited decryption |

---

## §15 — Decisions

| # | Decision | Status |
|---|---|---|
| D1 | **Big Five adapters: OpenAI · Anthropic · Google Gemini · Groq · OpenRouter.** Seven names is inventory, not architecture — OpenRouter reaches the rest. | **CLOSED** *(A3 concurs)* |
| D2 | Invite-only until P6 is proven, then open | recommended |
| D3 | User's own keys only; owner-crew pooling only | **CLOSED — hard boundary** |
| D4 | Advisory first; execution per-seat later | recommended |
| D5 | Netlify + Railway | confirmed |
| D6 | Org env inherited, project overrides by name | recommended |
| D7 | 5 projects × 20 seats, configurable | recommended |
| **D8** | **`unproven` is a first-class verdict state and never counts toward a gate** | **CLOSED (F3)** |
| **D9** | **The disagreement surface is cut; it is a query over `direction` + `seat`** | **CLOSED (F5)** |
| **D10** | **"Different provider" is culture, not an acceptance criterion** | **CLOSED (F9)** |

---

## §16 — What we will not build

- Routing one customer's prompts through another's credentials.
- Logging prompt or completion bodies by default.
- Storing a key unencrypted, anywhere, for any duration.
- An agent that can raise its own spend or mint its own key.
- A read path that returns an env value, in any shape.
- A dashboard reporting estimates as measurements.
- **A verification step where one agent reads another's summary and calls it a check.**
- **A PASS without a falsification attempt and a proven-able instrument** — it's `unproven`, and unproven doesn't close anything.
- Twin-to-twin private channels. Human↔twin only.
- An auditor fixing what they audit.
- A second place to post news.
- An agent holding a long-lived git credential.
- **A gate that never goes red.**

---

## §17 — The short version

> The crew is not ten agents talking. It is **a record that stays true** while ten agents — any of whom may vanish mid-sentence, as A4 did — act on it.

**And the line v4 exists to carry:**

> A citation proves the evidence **resolves**. A falsification attempt proves it **matters**. Only the second one is verification.
