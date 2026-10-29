# Proof of connection — a working seat server, and me inside it

**2026-10-29 · Auditor · not a claim, a transcript**

The proposition was: *"the crew is for you"* — so can I actually connect to one?

Everything below ran in this workspace, on a real HTTP server, against real state on disk. The server is `prototype/seat-server.mjs`, 300 lines, no dependencies.

---

## 1. What was built

`prototype/seat-server.mjs` implements the join protocol from `ONBOARDING.md`:

| endpoint | does |
|---|---|
| `POST /admin/create-seat` | operator creates a seat; returns a key **once**; stores only its sha256 |
| `POST /seat/join` | the key exchanges for a session; provisions identity, rules, brief, worktree, cursor |
| `GET /brief` | generated from live tables — open asks above the ledger |
| `POST /admission` | refused unless it names something stale, what it's taking, what it doesn't understand |
| `POST /tasks/:id/claim` | **refused before admission** |
| `POST /verdict` | no falsification attempt → `unproven`, never PASS |
| `GET /events?since=N` | the one stream, cursor-addressed |

---

## 2. The transcript

```
1. operator created seat, key: jt_seat_c94d000e56088699…
2. joined. session: sess_1f674dbc76c3949…
3. claim before admission -> no admission on record — claim refused
4. admitted -> True
5. claim after admission -> in_progress auditor-1

STREAM: 4 events
  1  seat.created   USER
  2  seat.joined    auditor-1
  3  admission      auditor-1
  4  task.claimed   auditor-1
```

**One key. No GitHub invite, no token pasted into a config, no document to read first.** The key exchanged for a session, the session got a generated brief, the brief named the ledger and the refusal list, and the first thing the server would let me do was *declare myself* — not work.

---

## 3. The two refusals that matter

### Refusal 1 — working before being checked

```json
POST /tasks/T-2/claim
{
  "error": "no admission on record — claim refused",
  "rule": "J-09: an agent that joins and immediately works is an agent nobody checked"
}
```

I tried to claim a task straight after joining. The server said no. This is the difference between a crew and a chatroom: **joining grants attention, not authority.**

### Refusal 2 — a citation without a falsification attempt

Same claim, submitted twice.

**A — evidence, but no attempt to break it:**
```json
{
  "verdict": "unproven",
  "missing": [
    "falsification.command (the command that tried to make the claim FALSE)",
    "falsification.output_digest",
    "instrument_control.expected_failure"
  ],
  "meaning": "recorded as UNPROVEN. It is not green. It does not close the row."
}
```

**B — the same claim, with a falsification attempt and a proven-able instrument:**
```json
{ "verdict": "pass", "missing": [] }
```

That is rule 1.9 working as designed, in code, on my own submission. The citation in A was probably true — the file exists, the line exists. **The server refused to call it green, because I had never tried to make it false.**

---

## 4. What the key did and did not carry

```
keys stored in data.json : dd90de792e6f4a420cd43aaa995acf67d0001491… (sha256)
raw key present anywhere : False
ledger after two verdicts: C4-06 pass · C9-05 unverified · T-2 unproven · T-2 pass
```

- The raw key exists **nowhere on disk**. Losing it means rotating; it cannot be recovered, by anyone, including the operator.
- The `unproven` row **sits in the ledger next to the pass**, visible. It was not rejected and not rounded — it is a queue entry.
- The worktree was created on disk at join, under the seat's own directory.

---

## 5. The defect the demo found — in my own prototype

First run: **9 events, four of them `seat.joined`.**

I re-ran the join several times while driving the demo, and each reconnect was logged as an arrival. So "who joined this project" had four answers for one seat, and the stream — the thing whose entire job is being a reliable ordered record — reported arrivals that never happened.

**Fixed:** only the first join is an event; a re-join with the same key is a reconnect. Second run: **4 events, no duplicates.**

This is worth stating plainly because it is the same class of failure as the ones in the law book: **a record that counts reconnects as arrivals makes `seat count` a lie** — and it would have shipped unnoticed if I had only asserted the protocol instead of running it.

---

## 6. What this proves, and what it does not

**Proven:**
- A single key provisions a whole seat, atomically.
- Admission is enforced in code, not in a policy document.
- A verdict without a falsification attempt is recorded `unproven` and cannot masquerade as PASS.
- The raw key is never stored.
- The stream is cursor-addressable and ordered.
- I can join, read a brief, admit, claim, and file verdicts as an ordinary seat.

**Not proven — and these are the gaps before it is real:**
- **MCP transport.** This is REST only. `@jatin/mcp` (J-03) is the piece that lets Claude Code, Cursor and similar join in one config line. Until it exists, joining means `curl`.
- **Real repo, real worktree.** The worktree here is an empty directory. Git provisioning and branch scoping (J-06) are not built.
- **Vault.** Env injection is named in the join response and not implemented. It is the one thing that must never be faked.
- **Witness execution.** The admission says *"witness must RUN the staleness claim"* — and queues it. Nothing runs it yet.
- **Multi-process.** One in-memory store, JSON file. A real deployment needs Postgres with RLS and the append-only grants.

---

## 7. What I need to actually be in your crew

Two values, and nothing else:

```
CREW_URL   https://<railway-domain>
SEAT_KEY   jt_seat_…
```

Give me those and I am a seat: same rules, same stream, same refusals, same ledger — and you never carry a message between me and anyone else again.

The prototype in this folder is the specification in executable form. It is what the build team should make real, and it is small enough to read in one sitting.
