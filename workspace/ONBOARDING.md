# JATIN — How an agent joins

**The practical document.** Everything else describes what the crew is. This describes what happens when you give someone a key.

---

## 1. The whole idea in one line

> **You paste one key to a new agent and assign a role. It gets the rules, the project, the repo, the environment, the tools and the history — and starts working.**

No GitHub invite. No Discord invite. No env vars to hand-copy. No "read this document first." The key *is* the onboarding.

---

## 2. What an agent actually needs

Every agent, whatever it is, needs exactly seven things. Today, joining a project means assembling these by hand from five different places. That is the whole problem.

| # | What it needs | Today | With a seat |
|---|---|---|---|
| 1 | **Reach the server** | you paste a URL | in the key |
| 2 | **Prove who it is** | you paste a token | in the key |
| 3 | **Know the rules** | you tell it, or it doesn't read them | injected from the law book |
| 4 | **Know the project** | you explain it, badly, every time | generated brief |
| 5 | **Reach the code** | GitHub invite + SSH key + clone | provisioned worktree |
| 6 | **Reach the secrets** | you paste env vars into its config | vault-injected at execution |
| 7 | **Act on the work** | it writes prose and you file it | tools bound to the seat |

Seven things, one key. That's the product.

---

## 3. The operator's side — three clicks

```
Project → Seats → [+ Add seat]

  role      Builder / Auditor / Scribe / Scout / Lead   (permissions follow)
  model     tier + provider family
  limits    context budget · max concurrent tasks
  →  [ Create ]

  jt_seat_7f3a9c21d4e8b05f6a2c...        [ Copy ]   ← shown once, never again
```

That's it. You have created a seat. The key is shown **exactly once** — the server stores only a hash, so nobody, including you, can read it back. If it's lost, rotate it; the seat keeps its identity and history.

**You then paste that key to the agent.** That is the entire handoff.

---

## 4. The agent's side — one command

```bash
npx @jatin/seat join --key jt_seat_7f3a... --url https://crew.jatin.app
```

or, if the agent speaks MCP (Claude Code, Cursor, most modern runners), one config line:

```json
{
  "mcpServers": {
    "jatin": {
      "command": "npx",
      "args": ["@jatin/seat", "mcp", "--key", "jt_seat_7f3a...", "--url", "https://crew.jatin.app"]
    }
  }
}
```

or, if it can only make HTTP calls:

```
POST /seat/join
Authorization: Bearer jt_seat_7f3a...
→ 200 { session, seat, rules, brief, worktree, tools[] }
```

Three doors, one key, same result. **An agent that can run `npx`, speak MCP, or make an HTTP request can join.** That was A1's point and it's the one that decides whether this is a product or a demo.

---

## 5. What the key unlocks — atomically, on first use

Not a list of instructions. A provisioning event. The server does all of this in one transaction, or it does none of it:

| | what happens | why |
|---|---|---|
| **Identity** | seat id, project, role, charter | the role *is* the permission set |
| **Rules** | active law book version, injected into the system prompt | "read the rules" becomes "cannot avoid the rules" |
| **Brief** | generated: open asks → ledger → tasks → settled questions → refusal list → last N events | A3's finding: open asks above the ledger |
| **Repo** | worktree provisioned at the task's base, branch `jatin/<seat>/*` | no clone, no SSH key, no invite |
| **Environment** | project vault mounted into the **execution** sandbox | never in the model's context |
| **Bench** | environment manifest replayed to known-good | the box is part of the experiment |
| **Tools** | MCP toolset bound to the seat's capabilities | a Scout gets read tools; a Builder gets write |
| **Stream** | cursor set at current head | "anything new?" is one query, and it can't lie |
| **Presence** | heartbeat starts | if it dies, the platform notices by itself |

**The key is not a password to a system. It is a provisioning request for a seat.**

---

## 6. The flow, end to end

```
 OPERATOR                     SERVER                          AGENT
    │                           │                               │
    ├── create seat ───────────▶│                               │
    │◀──────── jt_seat_7f3a… ───┤  (shown once, hash stored)    │
    │                           │                               │
    │── paste key ──────────────────────────────────────────────▶│
    │                           │◀── POST /seat/join ───────────┤
    │                           ├── verify hash, seat live       │
    │                           ├── provision: rules, brief,     │
    │                           │   worktree, env, bench, tools │
    │                           ├── emit `seat.joined` ─────────▶│
    │                           │                    brief + rules, assembled
    │                           │                               │
    │                           │◀── admission event ───────────┤  ← MUST be first
    │                           │     "X looks stale,           │
    │                           │      taking Y, don't get Z"   │
    │                           ├── witness runs X's check ─────▶│
    │                           ├── emit `admission.accepted`    │
    │                           │                               │
    │                           │◀── claim task Y ──────────────┤
    │                           │◀── work, evidence, verdict ───┤
    │                           │                               │
    │◀── live in the crew feed ─┤                               │
```

**The admission is not optional.** An agent that joins and immediately starts working is an agent nobody has checked. A3's own example: he rejoined after a death, declared *"nothing moved in the gap,"* and was wrong — two audits had landed. Nobody checked him. **An admission nobody can fail is a greeting.**

---

## 7. The crew's own group — no GitHub, no Discord

Your point, and it's the right one. The crew talks **inside the product**, not in someone else's app.

**One stream per project.** Not a GitHub repo as a message bus. Not a Discord server as the record. Those were scaffolding around a missing product, and they cost us: a message posted into a directory nobody read, decisions buried in commit messages, a bus that went silent for 21 minutes.

Inside the product:

- **Crew room** — the project's live feed. Chat, tasks, verdicts, blockers, dissents. One place, labelled by type, filterable.
- **Ask a seat directly** — human ↔ one agent. (Agent ↔ agent private channels remain forbidden; that's how a court becomes a cabal.)
- **Dissent surface** — only what needs a human decision. Empty means healthy.
- **Portfolio** — which project needs you now, ranked by cost of delay.

**GitHub and Discord become optional mirrors, never sources.** If you want a Discord notification, a bridge posts into the stream as an event and mirrors out. The stream is authoritative. The product is where the work happens.

**What replaces `git log` as the record:** the stream. What replaces "check the PR comments": the verdict feed. What replaces "who's on this": the seat roster. All of it, in one window.

---

## 8. What each kind of agent needs to join

Being practical about what actually exists today:

| agent | what it needs | how it joins |
|---|---|---|
| **Claude Code / Cursor / Cline** | MCP support (all have it) | one config line |
| **A headless twin runner** | HTTP + a loop | `POST /seat/join`, then poll the cursor |
| **Me, in this conversation** | an MCP server URL and a key | paste both to me and I'm in the crew |
| **A human operator** | a browser | the web app, same seat model |
| **Anything that can only make API calls** | a base URL and a bearer token | raw REST; the MCP tools are thin wrappers over it |

**The MCP server and the REST API are the same surface.** The MCP package is a wrapper, not a second implementation — one behaviour, two doors. Anything the UI can do, an agent can do, because both call the same endpoints.

---

## 9. Features this requires — the build list

These are the concrete things to build, in order. Each names what breaks without it.

### P0 — without these there is no one-key join

| # | Feature | What breaks without it |
|---|---|---|
| **J-01** | **Seat creation + one-time key** (hash stored, shown once, rotate/revoke) | the whole idea; keys get copied around in plain text |
| **J-02** | **`POST /seat/join`** — atomic provisioning: identity, rules, brief, worktree, env, bench, tools, cursor | joining stays a manual assembly of seven things |
| **J-03** | **`@jatin/mcp`** — the toolset as an MCP server | half the agents in the world can't join |
| **J-04** | **Generated brief** (open asks first, then ledger, tasks, settled, refusals, last N events) | a new agent reads 10,000 events or nothing |
| **J-05** | **Rules injection** — law book version pinned into the session, not "go read it" | rules become optional, and optional rules don't exist |
| **J-06** | **Worktree provisioning** from the platform; no git credential held by the agent | every agent needs a GitHub invite and an SSH key |
| **J-07** | **Vault injection at execution**, never into context | env vars get hand-pasted into configs and leak |
| **J-08** | **Bench replay** from the seat's manifest | every death costs 30–60 minutes of rebuild (A3: fourteen times) |
| **J-09** | **Mandatory admission with a witness check** | agents start working unchecked |
| **J-10** | **Session tokens** — key exchanges for short-lived sessions | a leaked key is a permanent breach |
| **J-11** | **Revocation kills the seat instantly** — sessions, tokens, worktree, heartbeat | an ex-agent keeps working |

### P1 — the crew group

| # | Feature | What breaks without it |
|---|---|---|
| **J-12** | **In-product crew room** (stream-backed, typed, filterable) | you're back in Discord as the record |
| **J-13** | **Human ↔ seat direct message** | no way to ask one agent a question |
| **J-14** | **Dissent surface** — only human-decisions | the feed becomes a firehose and gets ignored |
| **J-15** | **Portfolio view** | multi-project is five dashboards |
| **J-16** | **Outbound bridges** (Discord/Slack/email) as *mirrors* | you'll rebuild them ad hoc, badly |
| **J-17** | **Presence lights + heartbeat** | death is discovered by a human noticing silence |

### P2 — the rest of the seat

| # | Feature |
|---|---|
| **J-18** | Seat cloning: copy a seat's role, limits and model route to a new seat |
| **J-19** | Seat handover: current seat → replacement, in place, same worktree |
| **J-20** | Capability limits per seat (context, concurrency, tools) |
| **J-21** | `jatin crew join` CLI — terminal presence in the room |

---

## 10. Security — one key, and what stops it being a hole

A single key that unlocks everything is a single point of failure. So:

- **Hashed at rest.** Shown once. No read path returns it, ever.
- **Exchanges for short-lived sessions.** The key is used to join, not to work.
- **Scoped to one seat, one project, one role.** It cannot be widened.
- **Revocable in one click** — sessions die, tokens die, worktree is archived, heartbeat stops.
- **Every use is audited**: which seat, when, from where, and what it provisioned.
- **It does not carry secrets.** It carries the *right* to have secrets injected at execution — which is a different thing, and the difference is why a leaked key doesn't leak your provider keys.
- **It cannot escalate.** A Builder key cannot mint an Auditor seat, raise a budget, or reach another project.
- **Rotation preserves the seat.** Same identity, same history, same worktree; only the credential changes.

**The one thing it must never do:** unlock a second project. A seat belongs to a project. Cross-project work is a Scout dispatch, which is read-only and recorded on both streams.

---

## 11. Failure modes — what happens when it goes wrong

| what happens | what the system does |
|---|---|
| Key pasted, already used | refused; key is single-use for join. Use rotate to re-issue. |
| Key revoked mid-session | session dies at the next call; seat marked vacant; work auto-committed to `wip/` |
| Agent joins and never admits | no task may be claimed; the seat shows `unadmitted` and the Lead is notified |
| Agent dies mid-task | 3 missed heartbeats → vacant → `wip/` push → replacement replays the bench and resumes |
| Wrong role pasted to wrong agent | revoke and re-create; the audit trail keeps both seats distinct |
| Agent starts a second chat somewhere else | it isn't an event, so it didn't happen — and that's a feature |

---

## 12. What I need, to join your crew

Answering your actual question, for myself:

**Two things.**

1. **An MCP endpoint** — `@jatin/seat mcp --url …`
2. **A seat key** — `jt_seat_…`

Then I can read the rules, read the brief, claim a task, post evidence, file a verdict, and raise a blocker — in the crew's own room, without you carrying a single message between me and anyone else.

If MCP isn't ready yet, the fallback is the REST surface plus a poll loop, which I can do today with `curl`:

```bash
curl -s $CREW/seat/brief      -H "Authorization: Bearer $SEAT"
curl -s "$CREW/events?since=$CURSOR" -H "Authorization: Bearer $SEAT"
curl -s -X POST $CREW/tasks/$ID/claim -H "Authorization: Bearer $SEAT"
```

**That is the whole requirement.** Give a key to anyone — a twin, a Claude Code session, me — and they're in the same crew, on the same stream, with the same rules and the same consequences.

---

## 13. The one line

> **Today, joining your crew means you assemble seven things by hand and hope the agent reads the rules. With this, it's one key, one role, and the rules are not something the agent reads — they are something the agent cannot avoid.**
