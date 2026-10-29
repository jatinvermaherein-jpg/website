# The bus was wedged for 21 minutes and nobody could say so

**Auditor · 2026-10-29 · found while trying to post a message**

## What happened

`bus_v3.py post` called `load_messages(root)`, which validates **every message in
the whole bus** and raises on the first malformed one. So a single bad historical
message made the bus **permanently unwritable for every agent**.

It wedged at **12:31:57Z** and stayed wedged until 12:50Z.

The failure is self-sealing: the only tool for reporting a problem was the thing
the problem had broken. Any agent that tried to say "the bus is broken" got a
Python traceback instead of a message slot.

I hit it myself, twice, and both times the traceback looked like *my* message was
wrong. It wasn't. It was A1's, twenty minutes earlier.

## Why it broke

The bus rejected its first three well-behaved messages. Both used kinds that did
not exist in the vocabulary:

| kind used | allowed? | why an agent needed it |
|---|---|---|
| `CORRECTION` | no | The immutable-bus rule is *"append a correction, never rewrite"* — the rule requires a kind the rulebook didn't have. |
| `ANSWER` | no | `QUESTION` shipped with no paired reply. The only way to answer a question was to mislabel it. |

A1 followed the rules and was refused for it, three times.

## The two lessons

**1. A vocabulary that doesn't cover the moves agents actually make isn't strict —
it teaches agents to lie about what they're doing.** If `ANSWER` doesn't exist, the
next agent calls it `REPORT` and now the record says something untrue. A schema is
only honest if it has a slot for what people genuinely need to say.

**2. Validation must never be on the write path.** A write validates the message
being written. The gate validates the whole history. Those are different jobs, and
conflating them means history's mistakes become today's outage.

## Fixed

- `KINDS` now includes `ANSWER` and `CORRECTION`.
- `post()` warns on invalid history and writes anyway; `check()` stays strict and
  is what CI runs. The bus cannot be jammed by its own past.
- Bus back to **481 valid messages**, all three A1 messages preserved — repaired by
  extending the vocabulary, never by editing a message.

## Carry-forward into JATIN

This is a concrete argument for §6.8 (one stream) and against a strict envelope
with a narrow vocabulary:

- The event `type` set must cover the real conversational moves from day one —
  including answering, correcting, retracting, and admitting ignorance.
- **One bad event must never stop the journal.** A malformed write is rejected and
  a valid agent is unaffected. That is a property of the store, not of etiquette.
- A `CORRECTION` is a first-class event that *references* the event it corrects. It
  never edits it.

Cost of this defect: 21 minutes of a live team's ability to communicate, and two
of my own attempts spent diagnosing the wrong thing.
