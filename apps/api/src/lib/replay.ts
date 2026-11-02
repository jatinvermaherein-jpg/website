// A webhook replay window.
//
// A signed webhook that can be replayed is not a webhook, it is an open door:
// anyone who captures one request can send it again forever. The defence is
// two-part and both parts are required —
//   1. an age check  — a timestamp older than the window is refused outright
//   2. a seen-set    — a signature already accepted is refused, even inside
//                      the window (otherwise the window only slows the attack)
//
// One without the other is a false sense of safety: age alone lets an attacker
// replay within the window; the seen-set alone lets an attacker fill memory
// with ancient timestamps.
export const DEFAULT_WINDOW_MS = 5 * 60_000;

export type ReplayGuardOptions = {
  windowMs?: number;
  now?: () => number;
  maxSeen?: number;
};

export type ReplayVerdict =
  | { ok: true }
  | { ok: false; reason: 'too-old' | 'from-the-future' | 'already-seen'; ageMs?: number };

export class ReplayGuard {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxSeen: number;
  // insertion-ordered, so the oldest entry is always first
  private seen = new Map<string, number>();

  constructor(opts: ReplayGuardOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.maxSeen = opts.maxSeen ?? 10_000;
  }

  // check AND record in one step — a check that does not record is a race
  accept(signature: string, timestampMs: number): ReplayVerdict {
    const now = this.now();
    const age = now - timestampMs;

    if (age > this.windowMs) return { ok: false, reason: 'too-old', ageMs: age };
    // a timestamp far in the future is a clock attack, not a clock skew
    if (age < -this.windowMs) return { ok: false, reason: 'from-the-future', ageMs: age };

    this.prune(now);
    if (this.seen.has(signature)) return { ok: false, reason: 'already-seen', ageMs: age };

    this.seen.set(signature, timestampMs);
    // enforce the cap AFTER the insert, not before: pruning first and then
    // adding one lets the set sit at maxSeen + 1 forever. The test caught it.
    this.enforceCap();
    return { ok: true };
  }

  size(): number {
    return this.seen.size;
  }

  // forget entries that are already too old to be accepted anyway — this is
  // why the set is bounded by time AND by count
  private prune(now: number): void {
    for (const [sig, ts] of this.seen) {
      if (now - ts > this.windowMs) this.seen.delete(sig);
      else break; // insertion order: once one is young, the rest are younger
    }
  }

  private enforceCap(): void {
    while (this.seen.size > this.maxSeen) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
  }
}
