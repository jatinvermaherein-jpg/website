# JATIN — BUILD BRIEF (v1)

> **From:** the AI crew's planner
> **For:** the build team
> **Received:** 2026-10-29, via the Operator
> **Status:** SOURCE OF TRUTH. Where this brief and any other draft conflict, this brief wins.
> **Note:** `workspace/` is excluded from every build context. This file is a plan, not a payload.

---

## 0. In one paragraph

Two systems, one repo, one website. Flow is an API gateway that pools every provider key you own and spends the quota intelligently instead of leaving it to expire. Crew is a team of ten identical agents — same model, same tools, same capabilities — which coordinate through an immutable bus, build in parallel, audit each other, and survive any one of them dying mid-task. They are the same system viewed twice: Flow is a scheduler over scarce model capacity, Crew is a scheduler over scarce agent attention. Crew runs on Flow, which is what makes the whole thing more than the sum of two products.

## 1. What is being built

| | Flow | Crew |
|---|---|---|
| **What** | Multi-provider AI gateway | Team of 10 identical agents |
| **Solves** | "I have keys across five providers and most of my quota expires unused" | "I want a real agent team, not one chat window" |
| **User** | You, your team, and external users with their own dashboards | You, as the operator |
| **Surface** | OpenAI-compatible API + usage dashboard | Live board, bus feed, chat, interactive API |
| **Hosting** | Railway (backend) | Railway (same backend) |

One website on Netlify serves both: marketing, docs, dashboard, and the crew's live view. One repo. One database.

## 2. The design law — read this before designing anything

**Every agent is identical. They differ only by seat.**

Ten clones of the same model, given the same tools and the same freedom, do not produce ten opinions. They produce one opinion, ten times, with ten times the confidence.

This is not a philosophical point. It is the single failure mode that will make this product worthless while looking like it works. If the crew is a chorus, it is theatre. If the crew is a court, it is a product.

The difference is structural disagreement, and it is manufactured, not asked for:

1. **Different evidence.** Two agents disagreeing over the same text is noise. Two agents reading different sources — one the code, one the running system — and disagreeing is a finding.
2. **Different seat.** No agent may audit its own artifact. Ever. Not "shouldn't" — may not.
3. **Different direction.** One seat asks "is this true?". Another asks "what would make this false, and has anyone tried it?" Same agent, opposite prompt, and the second question finds the bugs.
4. **Different provider.** If the auditor runs on a different model family than the builders, the correlation breaks at the weights, not just at the prompt. This is why Flow and Crew ship together — Flow is what makes the auditor a genuinely different mind.
5. **Artifacts over claims.** A statement in chat is not evidence. A commit, a file, a measurement, a timestamp is. When an agent says "X is fine," the reply is not "OK" — it is "show me the artifact."

Everything else in this document is engineering. This section is the product.

## 3. FLOW — the gateway

### 3.1 The actual problem

Quota is perishable. A provider gives you 500,000 tokens this month, resets on the 1st, and whatever you did not spend is gone forever. Money you did not spend stays in your account. Quota does not.

So "use all my quota at max" is not a routing problem, it is an inventory problem with an expiry date. Most gateways get this wrong: they load-balance. They spread traffic evenly across keys, which means every key expires partially unused, and you have paid for capacity you never touched.

The correct instinct: **spend the quota that is about to die first.**

### 3.2 The pool

Four layers, each one a thing that can be exhausted or can break:

```
Provider  (OpenAI, Anthropic, Google, xAI, DeepSeek, + OpenRouter)
  └── Credential  (one API key; each key has its own independent limits)
        └── Model  (a key that can serve GPT-5 may not serve o-series)
              └── Window  (RPM / TPM / RPD / monthly — each with its own reset)
```

A "key" is not a quota. A key holds several simultaneous windows that reset on different clocks. One key can be fine on tokens-per-minute and dead on requests-per-day. The scheduler must know all of them at once.

### 3.3 The scheduler — use-it-or-lose-it

Selection, per request:

**Step 1 — hard filter.** Drop every candidate that is unhealthy, cooling down, or has any window without headroom for this request. This is not scoring; it is elimination. Never route into a wall.

**Step 2 — rank survivors by soonest expiring headroom.**

```
urgency(key) = Σ over windows w:   headroom_w
                                 ─────────────────────
                                 time_until_reset_w
```

A key whose daily window resets in 40 minutes with 60% unused scores far higher than a key that resets in 9 hours with 60% unused. Spend the one that dies first.

**Step 3 — tie-break on cost, then on quality.**

Ties broken by (a) lower cost per token, then (b) the model actually requested by the caller, then (c) lowest recent p95 latency.

**Step 4 — reserves.** Every key keeps a configurable reserve (default 5%) that bulk/background traffic may not touch. The reserve exists for one reason: when you need a burst, you need it now, and you cannot buy token quota at 3am. Background jobs burn the reserve last, foreground requests burn it first.

The honest version of "use all quota at max": you cannot hit 100%. Windows close while requests are in flight, cooldowns you didn't predict, providers miscount, and a reserve that gets spent is a reserve that wasn't there when you needed it. A good target is 92–97% of spendable quota, and the dashboard should show the real number rather than a marketing one. Anyone promising 100% is either not measuring or not reserving.

### 3.4 The failover ladder

Failures must escalate through a defined ladder, and every rung must be recorded — because "it worked" and "it worked after degrading to a weaker model" are different answers and the caller must be able to tell them apart.

```
same model, another key          ← most failures are key-scoped (rate limit, revoked)
same provider, equivalent model  ← model-scoped failure
another provider, same tier      ← provider-scoped outage
another provider, lower tier     ← degradation: FLAG IT
structured failure + reason      ← never a silent fallback to something dumb
```

Rule: **degradation is never silent.** Every response carries which model actually served it, and whether the requested model was honoured. A caller who asked for a frontier model and got a mini model has to be able to see that in the response, the log, and the dashboard.

### 3.5 Worked example (illustrative numbers)

You hold:

| Key | Window | Limit | Used | Resets in | Scheduler verdict |
|---|---|---|---|---|---|
| OpenAI A | RPM | 500 | 480 | 20 s | blocked, 20s |
| OpenAI B | TPM | 450k | 200k | 55 min | high urgency — big headroom, fast reset |
| Anthropic A | monthly | 12M | 11.7M | 6 days | low — 2.5% left, 6 days to use it |
| Google A | RPD | 1,500 | 300 | 4 h | medium |
| DeepSeek A | monthly | 50M | 2M | 21 days | low urgency, high headroom |

A normal load balancer sends the next request to whichever key is next in rotation and wastes OpenAI B's expiring headroom. Use-it-or-lose-it sends it to OpenAI B. Repeat for 55 minutes and you capture capacity that would otherwise evaporate.

### 3.6 API surface

Make the primary endpoint OpenAI-compatible. This is the highest-leverage decision in the whole build:

```
POST /v1/chat/completions      OpenAI-shaped; every SDK, every tool, works unchanged
POST /v1/messages              Anthropic-shaped
POST /v1/embeddings
GET  /v1/models                the union of everything your pool can actually serve
GET  /v1/usage                 per-key, per-model, per-window, real numbers
```

Any customer who can use OpenAI can use Flow by changing one base URL. Any coding agent, any framework, any library. That is worth more than any feature you could add instead.

Admin surface:

```
POST   /admin/credentials        add a key (write-only; never readable back)
GET    /admin/quota              every window, every key, live
GET    /admin/health             synthetic probe per provider
POST   /admin/policy             reserves, tier mapping, degradation rules
```

### 3.7 What's genuinely hard

- **Streaming + metering.** Token counts arrive at the end of a stream, but you must pass bytes immediately. Proxy SSE through untouched and reconcile usage on the terminal chunk; providers do report usage there. Do not buffer the response to count it — that destroys the product's feel.
- **Concurrency and the window race.** Two requests check headroom at the same instant and both spend it. Use atomic increments (Redis INCRBY on a TTL window, or a DB row lock). This is the most common way a gateway over-sends into a 429 storm.
- **Token estimation before sending.** You must know whether a request fits before you send it, and you cannot know the completion length in advance. Estimate prompt exactly (tokeniser per model family) and reserve a pessimistic completion allowance.
- **Provider drift.** Shapes change. Pin adapters, keep one contract test per provider that runs in CI daily, and treat a schema change as a page-worthy event.
- **Idempotency.** A retry must not double-count usage. Every request gets an ID; usage is recorded once, at final outcome.

## 4. CREW — the agent team

### 4.1 Seats

Ten seats, identical agents. The seat is the only thing that differs: its brief, its tools, its permissions, its model route.

| Seat | Count | Job | May not |
|---|---|---|---|
| **Operator** | 1 (human) | Decides. Final authority. | Be simulated by an agent |
| **Lead** | 1 | Decompose work, assign, unblock, hold the ledger true | Build anything themselves |
| **Builder** | 4–6 | Build. Own disjoint parts of the tree. | Audit their own work |
| **Auditor** | 1–2 | Independently verify. Issue scoped rulings. | Build (they'd become invested) |
| **Scribe** | 1 | Keep the record true; write handover continuously | Rule on correctness |
| **Scout** | 1 | External research, tool calls, evidence gathering | Commit product code |

Seats rotate. Artefacts do not. An agent may be a builder on Monday and an auditor on Tuesday. An agent may never audit an artifact it authored — that check is on the artifact's author, not on the seat, and it is enforced in software, not by politeness.

The Lead does not build. The moment the lead writes code, the lead stops being able to judge the work fairly, and the crew loses its one neutral scheduler. This is the most commonly violated rule in agent-team designs and the most expensive.

### 4.2 The bus — the immutable record

The bus is what makes ten agents a team instead of ten tabs. It is an append-only log. Messages are never edited and never deleted. Each has a strict envelope:

```
id         M-20261029T122344675115Z-AUDITOR-769c1d3d...   unique, generated
from       AUDITOR
to         ALL | LEAD | A1 | A3 ...
kind       RULING | ASK | BLOCKER | DISSENT | ACK | HANDOVER
utc        ISO-8601, always UTC
subject    one line
reply_to   id of the message this answers, or empty
deadline   required for BLOCKER, always UTC
```

Bodies are free text. The envelope is machine-validated on every write: a malformed message fails the build, not a human's patience.

**Immutability is the point.** A record that can be edited is a record that will be edited by whoever is losing the argument. Append a correction; never rewrite history.

**reply_to existing is not resolution.** This is a subtle and important rule. It is trivially easy to close a blocker by replying to it. The bus records the reply; the ledger is the thing that says whether the blocker is actually closed. They are separate, and the dashboard must show them separately.

### 4.3 The blocker protocol

A blocker that does not name its exit is a complaint. Every BLOCKER must carry four fields:

1. What is blocked — the specific downstream work.
2. Who or what can unblock it — a named seat, a human, a credential, a decision.
3. Deadline — UTC, always.
4. The assumption the crew proceeds under meanwhile.

That fourth field is the one people skip and the one that keeps the team moving. The crew never idles waiting. It marks the dependency unverified, states the assumption it is building on, and continues. When the blocker resolves, everything built on the assumption is re-checked — and the ledger already knows exactly which work that is, because the assumption was written down.

### 4.4 Chat is not a record

Two channels, deliberately:

- **Chat** — free, fast, messy. Recommend, suggest, doubt, joke, think out loud. This is where the quality comes from.
- **Bus** — slow, structured, immutable. Only what is load-bearing: rulings, assignments, blockers, handovers.

Anything that would cost something to lose must be promoted to the bus. Chat that never gets promoted is a conversation; chat that does is a decision trail.

The reason this matters: teams that record everything grind. Teams that record nothing forget why they did anything. The split — think freely in chat, commit decisions to the bus — is the only arrangement where both stay fast.

### 4.5 Cross-check that actually works

Weak version, and what most teams build:

> Agent A: "I implemented the retry logic, it's fine."
> Agent B: "Looks good to me."

That is not a check. B read A's summary of A's work. B has verified A's prose.

Strong version:

> Agent A claims: "retry logic handles timeouts."
> Agent B's job is not to read the code. It is to make it fail. Kill the network mid-request, count the retries, find the one path where the counter never increments. Report the number, not the opinion.

The rule that makes this operational: **every pass must cite an artifact a second agent could reproduce.** A commit SHA, a test name, a log line with a timestamp, a file and line number. If the claim cannot be reproduced from the citation, the seat is marked unverified regardless of how confident it sounded.

And because the agents are twins, add the correlation breaker: **the auditor runs on a different model family than the builders.** Two different weight-sets converging on the same answer is evidence. One weight-set agreeing with itself is not.

### 4.6 When an agent dies

It will. Mid-task, mid-sentence, out of context, rate-limited into the floor. Design for it as the normal case, not the exception.

- Nothing load-bearing lives in an agent's head. State lives in the bus, the task board, the ledger, the repo. An agent's context is a cache, not a store.
- Every task has an owner and a witness. The witness exists so that when the owner dies, the witness knows the state without asking the corpse.
- A heartbeat per seat. Miss three beats → the seat is declared vacant, automatically, and the Lead reassigns. No human in the loop for a routine death.
- The Scribe writes the handover continuously, not at the end. A handover written at the end is a handover written by whoever is left.
- No agent holds a unique credential. Credentials belong to the platform, scoped per seat, re-issuable in one action.
- A seat going vacant should be invisible to the Operator. That is the acceptance test: kill an agent mid-task on purpose and see whether the work still finishes without a human noticing.

### 4.7 The interactive API

The human is an actor on the bus, not a spectator.

```
POST /crew/messages      post as USER; same envelope, same validation
GET  /crew/stream        SSE live feed — rulings, blockers, dissents as they happen
GET  /crew/board         tasks, seats, who owns what, what's stuck
POST /crew/tasks         assign work
POST /crew/seats/claim   take a seat (human or agent)
```

The point of the live feed is dissent. Not "everything is going well" — that's a dashboard you stop reading after week one. It surfaces arguments, blockers about to breach deadline, and rulings that contradict each other. The Operator's attention is the scarcest resource in the system; the feed exists to spend it only where a human decision is genuinely required.

## 5. How the two systems interlock

This is the argument for building one product rather than two.

- **Crew runs on Flow.** Every agent's model call goes through the gateway. One place sees cost, latency, quotas, and which seat burns what.
- **Flow makes the audit real.** Builders on one provider, auditor on another — genuine independence, at the weights, for free.
- **Crew generates the load that tunes Flow.** Ten agents working is a continuous, realistic traffic pattern. The scheduler learns real distributions instead of synthetic benchmarks.
- **One identity, one bill, one dashboard.** The user sees "my agents spent ₹X across 5 providers" in a single number.

If you build only the gateway, you have a commodity — dozens exist. If you build only the crew, you have an expensive toy and a quota bill you cannot see. Together they are a system.

## 6. Data model (starting sketch)

```sql
-- identity
users(id, email, created_at)
orgs(id, name, plan)
memberships(user_id, org_id, role)

-- flow
user_api_keys(id, org_id, prefix, hash, name, revoked_at)     -- hashed, never stored plain
provider_credentials(id, org_id, provider, encrypted_secret,
                     key_mask, status, cooldown_until)        -- encrypted at rest
models(id, provider, provider_model_id, ctx_window, price_in, price_out, capabilities jsonb)
model_aliases(id, alias, model_id, priority)
quota_windows(id, credential_id, model_id, kind, limit, used, window_start, window_end)
requests(id, org_id, api_key_id, model_requested, model_served, credential_id,
         tokens_in, tokens_out, cost, latency_ms, status, degraded bool, created_at)
usage_rollups(org_id, bucket_start, model_id, requests, tokens, cost)  -- hourly

-- crew
seats(id, name, role, model_route, status, last_heartbeat)
tasks(id, title, owner_seat_id, witness_seat_id, status, artifact_refs jsonb)
messages(id, from_actor, to_actor, kind, utc, subject, body, reply_to, deadline)  -- append-only
rulings(id, message_id, row_ref, verdict, evidence_ref, issued_at)               -- append-only
ledger(row_id, requirement, status, evidence, owner_seat, expiry)                -- the truth
handovers(id, written_at, body)
audit_log(actor, action, target, ts)
```

Two rules the team must not soften:

1. `messages` and `rulings` have no UPDATE and no DELETE grant. Enforce it at the database, not in application code. If the app can rewrite history, so can a bug in the app.
2. Row-level security on everything, and a CI gate that fails if any table has a write grant with RLS off. This is not paranoia; it is the exact class of hole that lets a public key rewrite a production table while every test stays green.

## 7. Security — the keys are the crown jewels

Flow holds other people's provider credentials. That is the highest-value asset in the entire system, and everything else is secondary to protecting it.

- Encrypt credentials at rest with an envelope scheme (per-record data key, master key in KMS/env). Never plaintext in the database, ever, not even "temporarily".
- Never log prompts or completions by default. Opt-in debug mode, per-org, auto-expiring, and visibly flagged in the UI. The default must be: we cannot see your data.
- Never return a stored key. Once written, a credential is write-only. Show a mask, never the value.
- Never route user A's traffic through user B's key. Pooling keys across users means one user's prompts flow through another's account at the provider — a data-governance incident waiting to happen. The owner's crew may pool. External users bring their own keys. Make this a hard architectural boundary, not a policy.
- Rate-limit and authenticate every endpoint, including internal ones.
- Audit every decryption of a credential. If a key is used, there is a record of which request, which user, which moment.
- Scope seat credentials so a compromised agent cannot reach the credential table.
- No self-service spending. No endpoint that buys credits or raises its own limits without a human action. Agents may propose money decisions; they may never execute them.

## 8. Money

Three costs, and they behave differently:

| Cost | Behaviour | Control |
|---|---|---|
| Provider tokens | Variable, per request, capped by quota you already own | Scheduler + reserves |
| Infrastructure | Mostly fixed (Railway, Netlify, Postgres, Redis) | Right-size; scale on evidence |
| Your attention | The real cost | The feed surfaces only decisions |

Do not promise "unlimited." The pool is finite and the dashboard should say so in real numbers: "you have 3.2M tokens left across 5 providers, resetting between now and the 21st." Honesty here is the difference between a product people trust and one they leave after the first surprise.

Free-tier reality: free tiers do not carry a business. They pause, they rate-limit, they have no backup and no support. Free is fine for building and for the crew's own internal use; the moment external users depend on Flow, paid infrastructure is part of the product, not overhead.

## 9. Repo and deploy

```
jatin/
├── apps/
│   ├── web/          Next.js — marketing, docs, dashboard, crew live view  → Netlify
│   └── api/          Node/TS service — Flow + Crew                         → Railway
├── packages/
│   ├── core/         router, scheduler, quota engine, provider adapters
│   ├── crew/         seats, bus, tasks, ledger, handover
│   └── ui/           shared components
├── prisma/           schema + migrations
└── workspace/        plans, rulings, evidence  (never in a build context)
```

- Netlify builds `apps/web` only. Railway builds `apps/api` only. Neither ships the other, and neither ships `workspace/`.
- `workspace/` must be excluded from every build context. A plan that leaks into a Docker image is a plan published on the internet.
- One database, one migration history. Migrations run on deploy, owned by the deploy role, and no other role holds write grants on the ledger.
- Every deploy is reversible. Rollback rehearsed at least once, by someone who did not write the deploy script.

## 10. Build phases

Each phase has an acceptance test. A phase is done when a stranger can run the test and see it pass. Not when the builder says so.

| # | Phase | Acceptance (reproducible by someone else) |
|---|---|---|
| 0 | Foundations | Repo, CI, Postgres, one page deployed, one endpoint returns 200, seeded row read back |
| 1 | Flow passthrough | One provider, OpenAI-compatible /v1/chat/completions, streaming works, usage recorded with real token counts |
| 2 | Multi-key pool | Two keys one provider; kill one mid-run; request still succeeds; failover recorded in requests |
| 3 | Quota scheduler | Load test proves "soonest-reset-first" actually spends the expiring key first, with numbers |
| 4 | Multi-provider | Big Five adapters; same request served by any of them; degradation flagged in the response |
| 5 | Dashboard | A user adds a key, makes a request, sees real usage, revokes the key, and is locked out |
| 6 | Crew core | Ten seats, bus with envelope validation, task board; a malformed message fails CI |
| 7 | Crew runner | Agents execute real tasks through Flow; kill one mid-task, work still completes |
| 8 | Cross-check | Auditor on a different provider catches a deliberately planted bug the builders missed |
| 9 | Interactive | Human posts to the bus, sees a live rejection/blocker in the feed within seconds |
| 10 | Stunning | Design pass. This is not decoration — see §11. |

Do not compress 2–4. A gateway that cannot prove failover and quota behaviour is a proxy with a nice dashboard, and the first 429 storm will expose it.

## 11. What will bite you

1. Ten identical agents will converge and be wrong together. The most expensive failure, because it looks like consensus. Only structural disagreement (§2) defends against it.
2. Quota races. Two requests checking headroom simultaneously. Atomic counters or you over-send.
3. Silent degradation. The caller asked for a good model and got a cheap one without knowing. Always flag it.
4. Key leakage through logs. One `console.log(req)` and your credentials are in a log aggregator forever.
5. The Lead building. One line of product code from the lead and the crew loses its neutral judge.
6. A dying agent taking state with it. If it was only in that agent's head, it is gone. Bus, board, ledger, repo — nothing else.
7. "Stunning" meaning "decorated". Stunning is: nothing moves unless it means something; numbers are real; it is fast on a phone; the empty state teaches. A beautiful dashboard showing imaginary numbers is worse than an ugly one showing true ones.
8. Free tiers carrying load. Fine to build on, fatal to depend on.

## 12. Decisions I need before the team starts

These are the ones I cannot make for you, because they are product choices rather than engineering ones.

1. **Which five, exactly?** "The Big Five" — I am assuming OpenAI, Anthropic, Google, xAI, DeepSeek, with OpenRouter as a bonus adapter that reaches everything else and Groq as a fast lane. Confirm or correct.
2. **Who can use Flow?** Just you and your team at first, or public signup with billing? This changes auth, abuse control, and how much security work is mandatory before launch. My recommendation: invite-only until phase 5 is proven, then open.
3. **Whose keys does external traffic travel on?** Must be: the user's own. Pooling is for your crew only. Confirm you agree, because the alternative is a data-governance problem you cannot unfix.
4. **Do the agents write code and run commands, or are they advisory?** Advisory (chat, plans, review) is much cheaper and much safer. Executing agents need real sandboxing and real permission boundaries. Recommendation: start advisory, add execution per-seat later.
5. **Hosting confirmed?** Netlify for apps/web, Railway for apps/api. Note that Railway's free trial is time-boxed — budget for it.

## 13. What I would refuse to build

Stated now, so nobody asks later:

- Routing one customer's prompts through another customer's credentials.
- Logging prompt or completion bodies by default.
- Storing a provider key unencrypted, anywhere, for any duration.
- An agent that can raise its own spend limit.
- A dashboard that reports estimated numbers as if they were measured.
- A "verification" step where one agent reads another agent's summary and calls it a check.
