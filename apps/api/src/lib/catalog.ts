// 0006 — daily model-catalog checks.
//
// Provider model lists change — new models ship, old ones retire, and it
// happens daily on several providers. The gateway therefore:
//   · fetches each text pool key's /models at most once a day
//   · records every (provider, model) sighting with a last-seen date
//   · exposes the sightings so the operator's model workbench can flag a
//     rung whose model vanished from the catalog, and the customer's model
//     list can show real, currently-servable names with a "verified <date>"
//
// Refreshes are background-only (a stale catalog must never block or slow a
// request), bounded per tick, and de-duplicated per key in flight.
import type { PrismaClient } from '@prisma/client';
import { upstreamBase, TEXT_PROVIDERS } from './upstream.js';
import { decryptSecret } from './vault.js';

// "daily" with slack: anything checked within the last 20h is fresh.
export const CATALOG_TTL_MS = 20 * 3600_000;
const FETCH_TIMEOUT_MS = 15_000;
// how many keys a single background tick may refresh
const MAX_REFRESH_PER_TICK = 3;

const inFlight = new Set<string>();

export function catalogStale(checkedAt: Date | null | undefined, now = Date.now()): boolean {
  if (!checkedAt) return true;
  return now - checkedAt.getTime() > CATALOG_TTL_MS;
}

// Fetch one credential's catalog. Returns the model ids seen (empty when the
// provider has no catalog or the fetch failed — failures stay stale and are
// retried on the next tick).
export async function refreshCatalogForCredential(
  prisma: PrismaClient,
  cred: { id: string; provider: string; secretStored: string },
): Promise<string[]> {
  if (inFlight.has(cred.id)) return [];
  inFlight.add(cred.id);
  try {
    const stamp = () =>
      prisma.providerCredential
        .update({ where: { id: cred.id }, data: { lastCatalogCheckedAt: new Date() } })
        .catch(() => {});

    // search/image providers expose no model catalog — stamp "checked" so
    // the tick does not retry them forever
    if (!TEXT_PROVIDERS.includes(cred.provider)) {
      await stamp();
      return [];
    }
    const base = upstreamBase(cred.provider);
    if (!base) return [];

    const secret = decryptSecret(cred.secretStored, {
      prisma,
      actor: 'catalog',
      action: 'catalog.refresh',
      target: cred.id,
    });
    const res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return []; // leave stale — retried next tick

    const j = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    const models = ((j.data ?? []) as { id?: string }[])
      .map((m) => m.id)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);

    const now = new Date();
    if (models.length) {
      await prisma.$transaction(
        models.map((m) =>
          prisma.modelSighting.upsert({
            where: { provider_model: { provider: cred.provider, model: m } },
            update: { lastSeenAt: now },
            create: { provider: cred.provider, model: m, lastSeenAt: now },
          }),
        ),
      );
    }
    await stamp();
    return models;
  } catch {
    return [];
  } finally {
    inFlight.delete(cred.id);
  }
}

// Background refresh of stale pool keys. Fire-and-forget from the request
// path and the hourly tick; returns the number of keys refreshed.
export async function refreshStalePoolCatalogs(
  prisma: PrismaClient,
  orgIds: string[],
  now = Date.now(),
): Promise<number> {
  if (!orgIds.length) return 0;
  const creds = await prisma.providerCredential
    .findMany({
      where: { orgId: { in: orgIds }, status: 'active' },
      select: { id: true, provider: true, lastCatalogCheckedAt: true },
      orderBy: { lastCatalogCheckedAt: { sort: 'asc', nulls: 'first' } },
    })
    .catch(() => [] as { id: string; provider: string; lastCatalogCheckedAt: Date | null }[]);
  const stale = creds.filter((c) => catalogStale(c.lastCatalogCheckedAt, now)).slice(0, MAX_REFRESH_PER_TICK);
  if (!stale.length) return 0;

  const full = await prisma.providerCredential
    .findMany({ where: { id: { in: stale.map((c) => c.id) } }, select: { id: true, provider: true, secretStored: true } })
    .catch(() => []);
  let done = 0;
  for (const c of full) {
    if ((await refreshCatalogForCredential(prisma, c)).length > 0) done += 1;
  }
  return done;
}

// What do we know about a provider's catalog right now?
export async function providerCatalog(
  prisma: PrismaClient,
  provider: string,
): Promise<{ checkedAt: Date | null; models: { model: string; lastSeenAt: Date; firstSeenAt: Date }[] }> {
  const [checked, seen] = await Promise.all([
    prisma.providerCredential
      .aggregate({
        where: { provider, status: { in: ['active', 'cooldown'] } },
        _max: { lastCatalogCheckedAt: true },
      })
      .catch(() => ({ _max: { lastCatalogCheckedAt: null as Date | null } })),
    prisma.modelSighting.findMany({ where: { provider }, orderBy: { model: 'asc' } }).catch(() => []),
  ]);
  return { checkedAt: checked._max.lastCatalogCheckedAt, models: seen };
}

// For one alias: which of its rung models are in their provider's fresh
// catalog? 'live'   — every rung model seen in a catalog checked < 24h ago
// 'partial'— some rungs missing / catalog stale
// 'unknown'— no rung provider has ever been checked
export type CatalogStatus = 'live' | 'partial' | 'unknown';

export async function catalogStatusForTargets(
  prisma: PrismaClient,
  targets: { provider: string; providerModelId: string }[],
  now = Date.now(),
): Promise<{ status: CatalogStatus; verifiedAt: Date | null; missing: string[] }> {
  const providers = [...new Set(targets.map((t) => t.provider))];
  if (!providers.length) return { status: 'unknown', verifiedAt: null, missing: [] };

  let anyChecked = false;
  let allFresh = true;
  let verifiedAt: Date | null = null;
  const missing: string[] = [];

  for (const provider of providers) {
    const cat = await providerCatalog(prisma, provider);
    if (!cat.checkedAt) {
      allFresh = false;
      continue;
    }
    anyChecked = true;
    const fresh = now - cat.checkedAt.getTime() < 24 * 3600_000;
    if (!fresh) allFresh = false;
    if (!verifiedAt || cat.checkedAt > verifiedAt) verifiedAt = cat.checkedAt;
    const known = new Set(cat.models.map((m) => m.model));
    for (const t of targets.filter((t) => t.provider === provider)) {
      if (!known.has(t.providerModelId)) missing.push(t.providerModelId);
    }
  }
  const status: CatalogStatus = !anyChecked ? 'unknown' : allFresh && missing.length === 0 ? 'live' : 'partial';
  return { status, verifiedAt, missing };
}
