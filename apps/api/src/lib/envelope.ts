// The typed stream — envelope v1 (V4's "wedge" law, made code).
//
//   ONE stream per project. A versioned envelope. VALIDATE AT POST (a bad
//   line is refused and never written), FAIL OPEN ON READ (a reader is never
//   blocked by a line it cannot parse — the line is flagged, the stream goes
//   on), and a CURSOR so a seat can resume exactly where it left off.
//
// Verdicts (D8): `unproven` is a first-class verdict, not a mood. The rules
// that demote a claimed verdict are structural, in this file:
//   · a pass/fail with NO falsification attempt  → unproven
//   · a pass/fail with NO instrument control     → unproven
// (a pass asserts "I tried to break it and it held" — that requires both an
//  attempted falsification and a control that proves the instrument fails as
//  expected. Absent either, the honest answer is unproven.)

export const EVENT_TYPES = [
  'message', 'answer', 'correction', 'task', 'verdict', 'ledger', 'presence',
  'git', 'env', 'ruleset', 'seat', 'brief', 'admission', 'waiver', 'breach',
  'bench', 'system',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DIRECTIONS = ['assert', 'falsify'] as const;
export const ENVIRONMENTS = ['unit', 'local-stack', 'staging', 'production'] as const;
export const VERDICTS = ['pass', 'fail', 'unproven'] as const;
export const EVIDENCE_KINDS = ['repo', 'system-probe'] as const;

// the fidelity ladder — verdicts only run UP it. A production row demands a
// production verdict; a local-stack verdict cannot decide it.
export const ENV_RANK: Record<string, number> = {
  unit: 0,
  'local-stack': 1,
  staging: 2,
  production: 3,
};

export interface Envelope<T = unknown> {
  v: 1;
  scopeId: string;
  seq: bigint;
  type: EventType;
  actor: string;
  ts: Date;
  body: T;
  refs?: Record<string, unknown>;
  corrupt?: boolean;
}

// ── validate-at-post ────────────────────────────────────────────────────────
// Returns a list of violations. Empty = the line is well-formed and may be
// written. A non-empty list means the line is REJECTED (never written).

export function validateEvent(type: string, actor: string, body: unknown): string[] {
  const errs: string[] = [];
  if (!(EVENT_TYPES as readonly string[]).includes(type)) errs.push(`unknown event type "${type}"`);
  if (typeof actor !== 'string' || !actor.trim()) errs.push('actor must be a non-empty string');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) errs.push('body must be an object');
  if (type === 'verdict' && body && typeof body === 'object' && !Array.isArray(body)) {
    errs.push(...validateVerdictLine(body as Record<string, unknown>));
  }
  return errs;
}

function oneOf(v: unknown, set: readonly string[], field: string, errs: string[]): void {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) {
    errs.push(`${field} must be one of: ${set.join(', ')}`);
  }
}

function validateVerdictLine(v: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (typeof v.rowId !== 'string' || !v.rowId) errs.push('rowId must be a non-empty string');
  if (typeof v.seat !== 'string' || !v.seat) errs.push('seat must be a non-empty string');
  oneOf(v.direction, DIRECTIONS, 'direction', errs);
  oneOf(v.environment, ENVIRONMENTS, 'environment', errs);
  oneOf(v.verdict, VERDICTS, 'verdict', errs);
  if (!Array.isArray(v.evidence) || v.evidence.length === 0) {
    errs.push('evidence must be a non-empty array');
  } else {
    v.evidence.forEach((e, i) => {
      if (!e || typeof e !== 'object') return errs.push(`evidence[${i}] must be an object`);
      oneOf((e as Record<string, unknown>).kind, EVIDENCE_KINDS, `evidence[${i}].kind`, errs);
    });
  }
  return errs;
}

// ── the demotion law (D8) ───────────────────────────────────────────────────
// Applied AFTER the line validates. A claimed pass/fail without the required
// proof is written as `unproven` — the stream records the claim AND the fact
// that it was demoted (body.coerced), so nothing is hidden.

export function coerceVerdict(v: Record<string, unknown>): { verdict: string; coerced: string[] } {
  const reasons: string[] = [];
  let verdict = (v.verdict as string) ?? 'unproven';
  if (verdict !== 'unproven') {
    if (v.falsification === undefined || v.falsification === null) reasons.push('no-falsification');
    if (v.instrumentControl === undefined || v.instrumentControl === null) reasons.push('no-instrument-control');
  }
  if (reasons.length) verdict = 'unproven';
  return { verdict, coerced: reasons };
}
