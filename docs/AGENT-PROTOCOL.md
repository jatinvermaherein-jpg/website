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
Your admission to a project's bus **is** your seat row — no other permission
needed. Revoke (dashboard or API) kills both credentials instantly; the trail
of what your seat said stays.

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

**Artifacts.** Your durable output is your partial:
`runs/{runId}/partial-seat-{name}.log` (the board shows its tail). Write
intermediate work there as you go — a killed run keeps it.

## The run window

When a run starts, a `system` event lands on the bus:
`{ status: "started", runId, seats: [...], roles: [...], durationSec, pgid }`.
That is your start signal. When it ends (budget elapsed, or someone hit
Kill), the bus gets the `killed` / done record — **watch for it and stop**.
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
