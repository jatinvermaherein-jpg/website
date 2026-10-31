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

export type WindowKind =
  | 'rpm'
  | 'tpm'
  | 'rpd'
  | 'monthly_tokens'
  | 'monthly_cost_cents'
  | 'monthly_images'
  | 'monthly_searches';

export const ORG_LIMIT_KINDS = [
  'rpm',
  'tpm',
  'rpd',
  'monthly_tokens',
  'monthly_cost_cents',
  'monthly_images',
  'monthly_searches',
] as const;

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
  // org windows only: the model the limit applies to ('all' = whole account)
  model?: string;
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
    case 'monthly_images':
    case 'monthly_searches':
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

// Org-level windows — the operator-set account limits. Measured across EVERY
// request in the org's ledger, whatever key or credential served it: all of
// the account's gateway keys pool into the operator's numbers.
// `model` (the name the caller used) selects the view: account-wide limits
// (model IS NULL) always apply; per-model limits apply only to their model.
export async function orgWindows(
  prisma: PrismaClient,
  orgId: string,
  model?: string,
  now = new Date(),
): Promise<WindowState[]> {
  const limits = await prisma.orgLimit.findMany({
    where: { orgId, ...(model ? { OR: [{ model: null }, { model }] } : {}) },
  });
  const out: WindowState[] = [];
  for (const l of limits) {
    if (l.limit === null) continue; // an unset limit is not a limit
    const kind = l.kind as WindowKind;
    if (!ORG_LIMIT_KINDS.includes(kind)) continue;
    const [start, end] = windowBounds(kind, now);
    const category = kind === 'monthly_images' ? 'image' : kind === 'monthly_searches' ? 'search' : undefined;
    // a per-model row measures ONLY that model's traffic; the account-wide
    // row measures everything the account did
    const scope = l.model ? { modelRequested: l.model } : {};
    const agg = await prisma.request.aggregate({
      where: {
        orgId,
        ...scope,
        ...(category ? { category } : {}),
        createdAt: { gte: start, lt: end },
      },
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costCents: true },
    });
    let used = 0;
    switch (kind) {
      case 'rpm':
      case 'rpd':
      case 'monthly_images':
      case 'monthly_searches':
        used = agg._count._all;
        break;
      case 'tpm':
      case 'monthly_tokens':
        used = (agg._sum.tokensIn ?? 0) + (agg._sum.tokensOut ?? 0);
        break;
      case 'monthly_cost_cents':
        used = agg._sum.costCents ?? 0;
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
      model: l.model ?? 'all',
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
