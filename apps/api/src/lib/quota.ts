// Quota windows + the use-it-or-lose-it urgency score (Phase 3).
//
// Every number here is MEASURED from the Request ledger (the rows written
// by the gateway with the provider's own counts) — never estimated, never
// extrapolated. A key's window is the calendar slice in which its limit
// applies; headroom = effective limit − measured use; the reserve is the
// operator's cushion kept back from the edge (default 5%).
//
// urgency(key) = Σ_w headroom_w / msUntilReset_w      (tokens per ms)
// The key whose quota dies soonest — with the most to die — is the one we
// spend next. That is "soonest-reset-first", made into arithmetic.
import type { PrismaClient } from '@prisma/client';

export type WindowKind = 'rpm' | 'tpm' | 'rpd' | 'monthly_tokens' | 'monthly_cost_cents';

export interface WindowState {
  kind: WindowKind;
  limit: number;
  reservePct: number;
  effectiveLimit: number;
  used: number;
  headroom: number;
  windowStart: Date;
  windowEnd: Date;
  msUntilReset: number;
}

function minuteFloor(d: Date): Date {
  const x = new Date(d);
  x.setUTCSeconds(0, 0);
  return x;
}
function dayFloor(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function monthFloor(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function windowBounds(kind: WindowKind, now: Date): [Date, Date] {
  switch (kind) {
    case 'rpm':
    case 'tpm':
      return [minuteFloor(now), new Date(minuteFloor(now).getTime() + 60_000)];
    case 'rpd':
      return [dayFloor(now), new Date(dayFloor(now).getTime() + 86_400_000)];
    case 'monthly_tokens':
    case 'monthly_cost_cents':
      return [monthFloor(now), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))];
  }
}

interface LimitRow {
  kind: string;
  limit: number | null;
  reservePct: number;
}

export async function keyWindows(prisma: PrismaClient, credentialId: string, now = new Date()): Promise<WindowState[]> {
  const limits = await prisma.keyLimit.findMany({ where: { credentialId } });
  const out: WindowState[] = [];
  for (const l of limits) {
    if (l.limit === null) continue; // an unset limit is not a limit
    const kind = l.kind as WindowKind;
    if (!['rpm', 'tpm', 'rpd', 'monthly_tokens', 'monthly_cost_cents'].includes(kind)) continue;
    const [start, end] = windowBounds(kind, now);
    const rows = await prisma.request.findMany({
      where: {
        credentialId,
        source: 'flow',
        createdAt: { gte: start, lt: end },
      },
      select: { tokensIn: true, tokensOut: true, costCents: true },
    });
    let used = 0;
    switch (kind) {
      case 'rpm':
      case 'rpd':
        used = rows.length;
        break;
      case 'tpm':
        used = rows.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
        break;
      case 'monthly_tokens':
        used = rows.reduce((s, r) => s + r.tokensIn + r.tokensOut, 0);
        break;
      case 'monthly_cost_cents':
        used = rows.reduce((s, r) => s + r.costCents, 0);
        break;
    }
    const effectiveLimit = Math.floor(l.limit * (1 - (l.reservePct ?? 0) / 100));
    out.push({
      kind,
      limit: l.limit,
      reservePct: l.reservePct ?? 0,
      effectiveLimit,
      used,
      headroom: effectiveLimit - used,
      windowStart: start,
      windowEnd: end,
      msUntilReset: Math.max(0, end.getTime() - now.getTime()),
    });
  }
  return out;
}

// A key is spendable when EVERY window still has headroom.
export function isSpendable(windows: WindowState[]): boolean {
  return windows.every((w) => w.headroom > 0);
}

export function urgency(windows: WindowState[]): number {
  return windows.reduce((s, w) => {
    if (w.msUntilReset <= 0) return s;
    return s + Math.max(0, w.headroom) / w.msUntilReset;
  }, 0);
}

// the human-readable wall: which window ran out, when it resets
export function exhaustion(windows: WindowState[]): string | null {
  const dead = windows
    .filter((w) => w.headroom <= 0)
    .sort((a, b) => a.windowEnd.getTime() - b.windowEnd.getTime());
  if (!dead.length) return null;
  const w = dead[0]!;
  const secs = Math.max(1, Math.round(w.msUntilReset / 1000));
  return `${w.kind} limit reached (${w.used}/${w.effectiveLimit}); resets in ~${secs}s`;
}
