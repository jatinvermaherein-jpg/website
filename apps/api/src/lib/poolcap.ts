// Pool/grant reconciliation — the operator's per-model grants are carved
// out of the pool's REAL capacity, not out of air.
//
// The total pool for a model is the capacity of the operator's active pool
// keys that can serve it:
//   · a text alias  → the providers standing behind the alias
//   · 'search'      → the search providers (the rungs are summed: the first
//                     rung's limits plus the failover rung's limits)
//   · 'image'       → the image providers
// For each limit kind the pool capacity is the SUM of the pool keys' own
// key-limits for that kind. A pool key with no limit for a kind is
// unlimited — which makes the pool unlimited for that kind, so no
// reconciliation applies (cap = null).
//
// When the operator grants a customer a per-model limit that exceeds what
// the pool can back, the grant is clamped to a fraction of the pool
// capacity. The fraction reflects the account's 30-day usage (0.80 for a
// new / light account down to 0.30 for a heavy one) and the grant can
// never exceed the headroom left after the other accounts' grants.
import type { PrismaClient } from '@prisma/client';
import { SEARCH_PROVIDERS, IMAGE_PROVIDERS } from './upstream.js';

export interface PoolCap {
  cap: number | null; // null = unlimited pool for this kind
  keysCounted: number;
  unlimited: boolean;
}

export interface Reconciled {
  model: string | null;
  kind: string;
  requested: number;
  effective: number;
  capped: boolean;
  poolCap: number | null;
  grantedElsewhere: number;
  fraction: number;
  note: string | null;
}

// the fraction of pool capacity one account may hold, by its 30-day usage
export function fractionForUsage(requests30d: number, costCents30d: number): number {
  if (requests30d < 100 || costCents30d === 0) return 0.8;
  if (requests30d < 10_000 || costCents30d < 10_000) return 0.6; // < $100
  if (requests30d < 100_000 || costCents30d < 100_000) return 0.45; // < $1k
  return 0.3;
}

// Which providers' pool keys back this scope for this account?
export async function scopeProviders(prisma: PrismaClient, orgId: string, scope: string): Promise<string[]> {
  if (scope === 'search') return [...SEARCH_PROVIDERS];
  if (scope === 'image') return [...IMAGE_PROVIDERS];
  const aliases = await prisma.modelAlias.findMany({ where: { orgId, alias: scope }, select: { modelId: true } });
  if (!aliases.length) return [];
  const models = await prisma.model.findMany({ where: { id: { in: aliases.map((a) => a.modelId) } }, select: { provider: true } });
  return [...new Set(models.map((m) => m.provider))];
}

// Sum of the pool's key-limits for one kind across the given providers.
export async function poolCapacity(
  prisma: PrismaClient,
  orgId: string,
  providers: string[],
  kind: string,
): Promise<PoolCap> {
  if (!providers.length) return { cap: null, keysCounted: 0, unlimited: true };
  const keys = await prisma.providerCredential.findMany({
    where: { orgId, provider: { in: providers }, status: 'active' },
    select: { id: true },
  });
  if (!keys.length) return { cap: null, keysCounted: 0, unlimited: true };
  const limits = await prisma.keyLimit.findMany({
    where: { credentialId: { in: keys.map((k) => k.id) }, kind },
    select: { limit: true },
  });
  let sum = 0;
  let unlimited = limits.length < keys.length; // a key without a row for the kind is unlimited
  for (const l of limits) {
    if (l.limit === null) {
      unlimited = true;
    } else {
      sum += l.limit;
    }
  }
  return { cap: unlimited ? null : sum, keysCounted: keys.length, unlimited };
}

// How much of this (scope, kind) the OTHER accounts have been granted?
export async function grantedElsewhere(prisma: PrismaClient, scope: string | null, kind: string, exceptOrgId: string): Promise<number> {
  const rows = await prisma.orgLimit.findMany({
    where: { orgId: { not: exceptOrgId }, model: scope, kind },
    select: { limit: true },
  });
  return rows.reduce((acc, r) => acc + (r.limit ?? 0), 0);
}

// The account's 30-day footprint (drives the fraction).
export async function usage30d(prisma: PrismaClient, orgId: string) {
  const since = new Date(Date.now() - 30 * 24 * 3600_000);
  const [agg] = await Promise.all([
    prisma.request
      .aggregate({ where: { orgId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { costCents: true } })
      .catch(() => ({ _count: { _all: 0 }, _sum: { costCents: null } })),
  ]);
  return { requests: agg._count._all, costCents: agg._sum.costCents ?? 0 };
}

// Decide the effective limit for one requested model-scoped grant.
export function reconcileLimit(
  scope: string | null,
  kind: string,
  requested: number,
  pool: PoolCap,
  elsewhere: number,
  fraction: number,
): Reconciled {
  // account-wide (model NULL) or unlimited pool — nothing to reconcile
  if (scope === null || pool.cap === null) {
    return { model: scope, kind, requested, effective: requested, capped: false, poolCap: pool.cap, grantedElsewhere: elsewhere, fraction, note: null };
  }
  const headroom = Math.max(0, pool.cap - elsewhere);
  const allowed = Math.max(0, Math.min(pool.cap * fraction, headroom));
  const effective = requested <= allowed ? requested : Math.floor(allowed);
  const capped = effective < requested;
  let note: string | null = null;
  if (capped) {
    if (headroom <= 0) {
      note = `pool for this model is fully granted elsewhere (${elsewhere} of ${pool.cap}) — raise the pool or lower other accounts first`;
    } else {
      note = `capped to ${Math.round(fraction * 100)}% of the ${pool.cap} ${kind} pool (${Math.floor(allowed)}), ${elsewhere} already granted to other accounts`;
    }
  }
  return { model: scope, kind, requested, effective, capped, poolCap: pool.cap, grantedElsewhere: elsewhere, fraction, note };
}

// Full pool picture for the dashboard: per scope × kind.
export async function poolMatrix(
  prisma: PrismaClient,
  opOrgId: string,
  accountOrgId: string,
  scopes: string[],
  kinds: readonly string[],
): Promise<Record<string, Record<string, PoolCap & { elsewhere: number }>>> {
  const out: Record<string, Record<string, PoolCap & { elsewhere: number }>> = {};
  for (const scope of scopes) {
    if (scope === null || scope === '') continue;
    const providers = await scopeProviders(prisma, accountOrgId, scope);
    out[scope] = {};
    for (const kind of kinds) {
      const [cap, elsewhere] = await Promise.all([
        poolCapacity(prisma, opOrgId, providers, kind),
        grantedElsewhere(prisma, scope, kind, accountOrgId),
      ]);
      out[scope][kind] = { ...cap, elsewhere };
    }
  }
  return out;
}
