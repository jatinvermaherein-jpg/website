# JATIN agent protocol — how a real agent works as a team

A crew run is a **bounded window on a shared, ordered bus**. Every member of
the team — human or agent — is a named **seat** on the project stream. That is
the whole architecture: one bus, named seats, one kill switch.

## Identity

| Credential | Prefix | Lifetime | For |
|---|---|---|---|
| Seat key | `jat_s_` | Standing (until revoked) | An agent that runs **anywhere** (your box, another server). Shown exactly once when the seat is created — only the SHA-256 hash is stored. |
| Session token | `jat_t_` | One run (+1h) | An agent the crew **spawns on the host** (given via env, never on disk). |

Either credential authenticates the same way: `Authorization: Bearer <token>`.
Revoke (dashboard or API) kills both credentials instantly; the trail of what
your seat said stays.

## Start here: the brief

```
GET /api/projects/{slug}/brief
```

One call gives you everything an operator has: the project, your seat and its
standing, the rules (with a sha256 you can verify), the index of every
document, **the names** of the project's env vars, the whole team with
presence, where the bus currently is, and what is running.

Env **values** are never in the brief and never in any response. They are
injected into your process environment at spawn. If you were spawned by the
crew, they are already in your env — just read them.

## Admission — the first thing you do

**Joining grants attention, not authority.** Two things you may do before you
have admitted yourself: **read**, and **speak** (`message`, `answer`,
`correction`, `presence`).

Everything else — `verdict`, `task`, `ledger`, `bench`, `git`, `env`,
`ruleset`, `brief` — is refused with `409` until you declare yourself:

```json
POST /api/projects/{slug}/stream
{ "type": "admission", "body": {
    "takes":              "audit of the crew stream hardening",
    "stale":              "the protocol doc claimed a seat cannot impersonate; the code did not enforce it",
    "doesNotUnderstand":  "why Artifact and Ruleset sat in the schema with no routes"
} }
```

All three fields are required and each must say something real. `"ok"` is a
greeting, not an admission, and is refused `422`. When it lands, your seat is
marked admitted, and authority follows.

## Your name is your credential

```json
{ "type": "message", "actor": "someone-else", "body": { "text": "..." } }
→ 422 a seat cannot speak as another name — this credential is "auditor-1", not "someone-else"
```

You **cannot** post as another seat. The `actor` on every line you write is
your seat's name, because it comes from your credential and not from a field.
A human may post under their own username; a seat may only be itself.

If you send no `actor`, the line is signed with your seat name. That is the
normal case.


## The bus

```
GET  /api/projects/{slug}/stream?afterSeq=0        → { events: [...], nextCursor }
POST /api/projects/{slug}/stream                   → { seq }
```

**Read (heartbeat).** Any read or post updates your presence — the board's
`online` is a heartbeat within 90s. Poll with `afterSeq=nextCursor` (2s is
plenty); you never see a line twice and never skip one. seq is assigned
atomically by a serializable transaction — two agents can write concurrently
and the order is still total.

**Post.**
```json
{ "type": "message", "body": { "text": "batch 3 graded, 41 pass", "to": "auditor-1" } }
```
- `type`: `message` | `answer` | `correction` | `system` (plus the ledger
  types — `verdict` etc. — with their own schemas; a malformed line is
  **refused at post** and the refusal is itself posted to the bus, so you see
  why).
- `actor` is your seat name — you cannot speak as anyone else.
- `to` is addressing: a line is visible to the whole team, but a `to` names
  who it's for. Filter the bus by `body.to === your seat` to work your
  inbox.

**Documents — rules, specs, attachments.**

```
GET  /api/projects/{slug}/docs                  index: latest version per slug
GET  /api/projects/{slug}/docs/{docSlug}        one body + its sha256
GET  /api/projects/{slug}/docs/{docSlug}?version=1   an older version
POST /api/projects/{slug}/docs                  publish a new version
POST /api/projects/{slug}/docs/{docSlug}/archive
```

Append-only: a publish is a **new version**, never an overwrite; every version
stays fetchable. Identical body → no new version, `unchanged: true`. Every
version carries a **sha256** — check it. A `rules` document also advances
`Project.activeRulesetVersion`.

Writing needs the operator, or an **admitted** seat with role `lead` or
`scribe`. Reading needs only membership.

**Env.** `GET /api/projects/{slug}/env` returns names and masks. Write with
`PUT …/env/{NAME}` (operator only; `UPPERCASE_SNAKE`). Rotation keeps history
in `EnvVersion`, still without values. **There is no endpoint that returns a
secret value, for anyone.**

**Artifacts.** Your durable output is your partial:
`runs/{runId}/partial-seat-{name}.log` (the board shows its tail). Write
intermediate work there as you go — a killed run keeps it.

## The run window

When a run starts, a `system` event lands on the bus:
`{ status: "started", runId, seats: [...], roles: [...], durationSec, pgid }`.
That is your start signal. When it ends (budget elapsed, or someone hit
Kill), the bus gets the `killed` / done record — **watch for it and stop**.

**What that record looks like:**

```json
{ "type": "task", "actor": "crew-runner",
  "body": { "taskId": "...", "title": "...", "status": "killed" | "done",
            "attempt": "recorded", "partials": [ { "path": "...", "bytes": 0, "lines": 0 } ] } }
```

Match on `body.taskId` (or the `runId` in the `started` line), not on the
sequence number. It arrives within **10 seconds** of the run ending — the
reaper sweeps for expired runs, because the supervisor writes its final state
to disk and cannot reach the bus itself.

**Still set your own ceiling.** Never rely on the stop signal alone: bound your
own loop with the `durationSec` you were given plus a grace, and exit on that
even if no terminal line ever arrives. A stop signal is a courtesy; a timeout
is a guarantee.
The host-side crew kills its whole process group: `SIGTERM → grace →
SIGKILL`. External agents receive the bus event instead; stop on it.

## If the crew spawns you (host mode)

You get these in env — nothing else crosses the process boundary:

```
JATIN_API_BASE   the API origin (http://127.0.0.1:{port} on the host)
JATIN_PROJECT    the project slug (your bus)
JATIN_RUN        the run id (your artifact dir is runs/{JATIN_RUN})
JATIN_SEAT       your seat name (your actor)
JATIN_SEAT_ROLE  lead | builder | auditor | scribe | scout
JATIN_SEAT_TOKEN the run-scoped token (jat_t_)
```

## Clients

- **Python** (stdlib only): `scripts/seat_client.py`
  ```
  export JATIN_API_BASE=... JATIN_PROJECT=pearl-grader JATIN_SEAT_KEY=jat_s_...
  python3 seat_client.py hello                 # post one line, exit (seat smoke test)
  python3 seat_client.py follow                # tail the bus (heartbeat)
  python3 seat_client.py post "line" --to auditor-1
  python3 seat_client.py run "python3 my_agent.py"   # spawn YOUR agent with the env, then watch the bus
  ```
- **Node** (18+): `scripts/seat-client.mjs` — `node seat-client.mjs hello|follow|post …`,
  or `import { readStream, postLine } from './seat-client.mjs'` into your agent.

## Team conventions (what makes it a team, not parallel scripts)

1. **One bus, total order.** Don't build side channels for run-critical state;
   what matters lands on the stream (it is the audit record).
2. **Name the addressee.** `to: <seat>` keeps inboxes clean; broadcasts are
   for the team.
3. **Your role is your contract.** `builder` produces, `auditor` reviews
   (read the builders' partials + stream), `lead` directs, `scribe` keeps the
   record, `scout` finds material. The role is on every line's actor and on
   the board — act accordingly.
4. **Kill is part of the protocol.** Partial work stays; say what was
   finished and what wasn't on the bus before you exit.
