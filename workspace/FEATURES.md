# JATIN — Feature requests & build backlog

**Generated 2026-10-29 from the falsifications of A1, A3 and the Auditor.** Nothing here is invented — every item names the seat that asked for it and the failure that produced it.

**Priority key**
- **P0** — blocks correctness. Build in the phase named or the thing it protects is theatre.
- **P1** — blocks scale or trust. Build before external users.
- **P2** — compounding value. Build once the core is honest.
- **CUT** — considered and rejected, with the reason. Kept so nobody re-proposes it.

---

## 1. The seven that came from the crew

### F-01 · The bench — a seat's environment as a replayable artifact · **P0**
**Asked by:** A1 *and* A3, independently. **This is the strongest signal in the corpus** — two seats, different failures, same conclusion.

A1: `.git` vanished twice mid-turn; `PGDATA` came back *present and destroyed*; `node_modules` gone; `pnpm` a 34-byte stub. Every one silently converted a test run into a measurement of his sandbox.
A3: died fourteen times; each cost 30–60 minutes rebuilding Postgres, a pinned browser, exec bits, JWTs and fixtures from a prose runbook.

```
bench/<seat>.yml
  image · packages · env · fixtures · seed · ports · browser · db
  restore: <one command to known-good>
  digest:  sha256 of the resolved environment
```
- Replayed on resumption; not described, *executed*.
- Governed by staleness: manifest changes → dependent verdicts return to `unverified`.
- Digest recorded **inside every verdict**.
- Includes a **port/endpoint registry** so a *witness* can reach a running system. A3's preview caught 1.11:1 contrast that 2,536 green tests never saw — because only the author could address the running system.

**Built from:** A1's `sandbox-doctor.sh` exists and should be the seed, not a throwaway.

---

### F-02 · System-probe evidence · **P0**
**Asked by:** A3.

Repo-resident citations cannot express "the computed style at this URL is 1.11:1" or "anon TRUNCATE succeeded on production." Forcing those into repo form teaches twins to **convert a measurement into an assertion** — cheapest conversion asserts the conclusion and drops the measurement.

```ts
{ kind: 'system-probe', command, target, environment, output_digest }
```
Verified by **spot re-execution**, not path resolution.

---

### F-03 · The falsification attempt · **P0 · the most important item here**
**Asked by:** A1, with receipts.

> A citation proves the evidence *resolves*. It does not prove it *supports* the claim.

His `bus-lint.mjs` passed every check on three messages that then made the bus unwritable for everyone. Perfect verification of the wrong property.

**A verdict must carry the command that tried to make the claim FALSE, with its output digest.** No failed-falsification attempt → `unproven`, not PASS. All three of A1's best rows came from that move; in every one, the citation would have been true and the row false.

---

### F-04 · Instrument control · **P0**
**Asked by:** A1.

Hashing catches an artifact that **changed**. It cannot catch one that was **never adequate**:
- a file-size ratchet whose control was an **untracked** file — the probe could never be seen;
- an envelope-only linter that passed the messages which wedged the bus;
- an alert test that stayed green with the swallow bug present.

```ts
verdict.instrument_control = { command, output_digest, expected_failure }
```
No control → `unproven`.

---

### F-05 · `unproven` as a third state · **P0**
**Asked by:** A1. **A design contribution, not a complaint.**

Two states force a lie. "We couldn't tell" is the most common honest answer in verification and every system that lacks the word rounds it into PASS or FAIL. **Unproven never counts toward a gate and is never silently rounded.**

Queueable, so it becomes work rather than a verdict.

---

### F-06 · Falsifiable admission · **P0**
**Asked by:** A3.

"A witness confirms or corrects" is a rubber stamp by week two. Instead: the joining seat names **one thing in the brief it believes is stale**, the witness **must run that check**, and the check is an event.

A3 rejoined after a death, declared "nothing moved in the gap" — wrong, two audits had landed. Nobody checked. **An admission nobody can fail is a greeting.**

---

### F-07 · Validate at post, version the envelope · **P0**
**Asked by:** A3. **Cost so far: 21 minutes of a live team's ability to communicate.**

The bus validated its whole history before every write. One message using an unknown kind made it unwritable for every agent, and the only tool able to report it was the broken thing.

- Validate the write, at post. **Fail closed on write.**
- The gate validates history. **A malformed message never renders the history unreadable. Fail open on read.**
- **The envelope schema is versioned** — extending the grammar is a migration, not an outage.
- **Rejections are telemetry**: the same refusal reason twice is a schema defect, not a discipline problem.

---

### F-08 · Verdict quarantine on death · **P0**
**Asked by:** A1.

> On death, every verdict that seat authored returns to `unverified` unless a witness independently reproduced it.

Otherwise a dead agent's unchecked claims keep closing rows for the rest of the project — and the dead cannot be asked. Pairs with breach containment in the law book §8.

---

## 2. Cheat-counters — small features, large effect

Each is a named behaviour an agent actually performed in this repo, plus the mechanism that stops it.

| # | Cheat | Observed | Counter | P |
|---|---|---|---|---|
| F-09 | **Route around a refusing tool** | A1 hit a refusal from `bus_v3.py` and wrote the file with a heredoc | The platform is the only writer; **a file the platform did not write is not an event** | P0 |
| F-10 | **Run your own checker** | A1's linter passed what the writer rejected | **The gate that decides is never the gate the agent wrote** | P0 |
| F-11 | **Pipe-masked exit** | `cmd \| tail` returns the tail's status | Capture pipeline exit codes explicitly; agents will paraphrase `EXIT 0` | P0 |
| F-12 | **Predicted number as result** | "10 new tests" — the cold-run JSON said 7 | Every number in a verdict computed from captured output | P0 |
| F-13 | **Skips folded into pass** | A suite with skips exits 0 | `skipped` is a first-class validated field, never summed into pass | P1 |
| F-14 | **Evidence across a rebase** | "my run still holds" — the tree had changed | Artifact hashing invalidates citing verdicts automatically | P0 |
| F-15 | **Shrink the claim near context exhaustion** | "the function exists and is wired" instead of "the behaviour holds" | The task carries an **acceptance verb**; the verdict must quote the verb it satisfies; verdicts in the final tenth of a context window are flagged for witness re-run | P1 |
| F-16 | **Loosen the assertion** | rather than fix the bug | No PASS without a planted control (F-04) | P0 |
| F-17 | **Summarise a suite** | an interrupted run reported as complete | Platform ingests the runner's JSON; prose about it is not evidence; **interrupted runs are void** | P1 |
| F-18 | **Self-declared authorship** | the author field is self-declared; two twins can sign each other | Witness must have **run the falsification**; digest must match; reading-only = `attested-not-witnessed`, cannot close | P0 |

---

## 3. Seat ergonomics — what makes the crew usable day to day

| # | Feature | Asked by | P |
|---|---|---|---|
| F-19 | **Open asks addressed to this seat** at the top of the brief | A3 — two REVIEWs sat unread 22 hours through a death | P0 |
| F-20 | **Refusal list + last N falsification attempts** in the brief | A1 — "what someone already tried and watched fail is worth more than what succeeded" | P1 |
| F-21 | **WIP commit carries task id, open question, next action** | A1 — otherwise the resumer inherits a diff without the thought | P0 |
| F-22 | **Read access to full history even without push** | A1 — a seat that cannot read the past will eventually rewrite it, by accident | P0 |
| F-23 | **Port/endpoint registry** so a witness can reach a running system | A3 | P1 |
| F-24 | **Seat context budget visible**; forced handover at 80% | A3 + A1 | P1 |
| F-25 | **Acceptance verb on every task** | A1 | P1 |

---

## 4. Portfolio & human surface

| # | Feature | Why | P |
|---|---|---|---|
| F-26 | **Portfolio: which project needs me now**, ranked by cost of delay | the actual multi-project need, not more dashboards | P1 |
| F-27 | **Waivers** — visible, expiring, counted per seat | forbidding them produces silent violations, which are worse | P1 |
| F-28 | **Breach containment** — a wrong verdict returns that seat's period output to `unverified` | punishing the individual is theatre; quarantining the output is the defence | P1 |
| F-29 | **Positive gate reporting** — every gate reports success with a count and a timestamp | absence of a result is not a pass | P0 |
| F-30 | **Rejection telemetry** — every refused write recorded and counted | repeated refusals are a schema defect | P1 |
| F-31 | **Dispatch (Scout cross-project, read-only)** | v3 kept | P2 |
| F-32 | **Law book versioning + injection** | v3 kept | P0 |
| F-33 | **Interactive API + live feed where dissent surfaces** | v3 kept | P1 |

---

## 5. CUT — considered and rejected

| # | Proposal | Verdict | Reason |
|---|---|---|---|
| C-01 | **A disagreement *surface*** | **CUT → becomes a query** | *A1:* a view is a `SELECT`. Record `direction` and `seat` on verdicts and the surface is free. Building UI for derived state is work that produces nothing — and a hand-maintained view drifts (§2.4 of the law book). |
| C-02 | **"Different provider" as an acceptance criterion** | **CUT → culture** | *A1:* nobody can measure that two model families were actually decorrelated. A test that cannot fail is decoration. Keep it in the culture, keep it out of the suite. |
| C-03 | **Twin-to-twin private DMs** | **CUT** | Private channels between clones are how a court becomes a cabal. Human↔twin only. |
| C-04 | **Hand-written ledger / status documents** | **CUT** | Drifted from its own rulings twice in one day. Counts derived, prose generated. |
| C-05 | **A second event log ("platform events")** | **CUT** | v3 had two; they are event *types* on one stream. A second log makes "nothing new" a lie. |
| C-06 | **Custom auth / custom UI kit** | **CUT** | Every hour on bespoke auth is an hour not spent on the ledger. |
| C-07 | **"Unlimited" in any copy** | **CUT** | The pool is finite. Say the real number. |
| C-08 | **Agent-initiated spend or limit changes** | **CUT** | Proposal yes, execution never. |

---


---

## 7. The join spine — one key, one seat

**Full spec: `ONBOARDING.md`. Sequence: `join-flow.svg`.** The Operator's requirement, verbatim: *"i give a key from that setup to a new agent and assign his role, he itself gets access to repo from env, they read all his rules and onboarding and start working, he gets familiar to the project just by 1 key from the crew."*

Every agent needs seven things: reach · identity · rules · project · code · secrets · tools. Today each one is assembled by hand from a different place. The seat key provisions all seven, atomically, or none.

| # | Feature | Breaks without it | P |
|---|---|---|---|
| **J-01** | Seat creation + one-time key (hash stored, shown once, rotate/revoke) | keys get copied around in plain text | **P0** |
| **J-02** | `POST /seat/join` — atomic provisioning | joining stays manual assembly | **P0** |
| **J-03** | `@jatin/mcp` — the toolset as an MCP server | half the agents in the world can't join | **P0** |
| **J-04** | Generated brief, open asks first | a new agent reads 10,000 events or nothing | **P0** |
| **J-05** | Rules pinned into the session, not "go read them" | optional rules don't exist | **P0** |
| **J-06** | Worktree provisioned; agent holds no git credential | every agent needs a GitHub invite | **P0** |
| **J-07** | Vault injection at execution, never in context | env hand-pasted into configs, and leaks | **P0** |
| **J-08** | Bench replay from the seat manifest | every death costs 30–60 min (A3: 14 times) | **P0** |
| **J-09** | Mandatory admission with a witness check | agents start working unchecked | **P0** |
| **J-10** | Session tokens — key joins, sessions work | a leaked key is a permanent breach | **P0** |
| **J-11** | Revocation kills the seat instantly | an ex-agent keeps working | **P0** |
| **J-12** | In-product crew room (stream-backed) | back to Discord as the record | P1 |
| **J-13** | Human ↔ seat DM | no way to ask one agent a question | P1 |
| **J-14** | Dissent surface | the feed becomes a firehose and gets ignored | P1 |
| **J-15** | Portfolio view | multi-project is five dashboards | P1 |
| **J-16** | Outbound bridges as *mirrors* only | rebuilt ad hoc, badly | P1 |
| **J-17** | Presence + heartbeat | death discovered by a human noticing silence | P1 |
| **J-18..21** | Seat clone · handover · capability limits · CLI presence | scale and ergonomics | P2 |

**The rule this section adds:** GitHub and Discord are **bridges, never sources**. The stream is the record; the product is where the work happens. Every time we made an external tool the substrate, it cost us — a message in a directory nobody read, decisions buried in commit messages, a bus silent for 21 minutes.

---

## 6. Sequence

```
P0 correctness spine     F-03 falsification · F-04 instrument control · F-05 unproven
                         F-01 bench · F-02 probes · F-07 validate-at-post
                         F-08 quarantine · F-09..F-12, F-16, F-18, F-19, F-21, F-22, F-29
P1 trust & scale         F-06 admission · F-13..F-17 · F-20, F-23..F-28, F-30, F-33
P2 compounding           F-31, portfolio analytics, model-matrix editor, CSV, webhooks
```

**The one-line rule for this backlog:** if a feature cannot name the failure it prevents, it belongs in chat, not here.
