// 0008 — per-key MODEL LIVENESS.
//
// The catalog (0006) knows a model NAME exists on a provider. Liveness
// proves something the catalog cannot: that THIS key's account can actually
// SERVE that model (availability is per account — one key 404s on a model
// the next one serves fine). Probes are 1-token pings; sweeps are bounded
// and run in the background (hourly tick + on-demand operator check), so a
// slow or dead provider never delays traffic.
import type { PrismaClient } from '@prisma/client';
import { decryptSecret } from './vault.js';
import { upstreamBase, TEXT_PROVIDERS } from './upstream.js';

const PROBE_TIMEOUT_MS = 20_000;
// a check is "fresh" for a day; older results render as unverified
export const LIVENESS_TTL_MS = 24 * 3600_000;

export interface RungRef {
  provider: string;
  providerModelId: string;
}

// the distinct (provider, model) pairs any assigned ladder uses today —
// those are the only ones whose liveness matters
export async function liveRungModels(prisma: PrismaClient): Promise<RungRef[]> {
  const aliases = await prisma.modelAlias.findMany({ select: { modelId: true } }).catch(() => [] as { modelId: string }[]);
  if (!aliases.length) return [];
  const ids = [...new Set(aliases.map((a) => a.modelId))];
  const models = await prisma.model
    .findMany({ where: { id: { in: ids } }, select: { provider: true, providerModelId: true } })
    .catch(() => [] as { provider: string; providerModelId: string }[]);
  const seen = new Set<string>();
  const out: RungRef[] = [];
  for (const m of models) {
    const k = m.provider + '/' + m.providerModelId;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

// one 1-token ping. ok=true only on a real 200 from the provider.
export async function pingModel(
  prisma: PrismaClient,
  cred: { id: string; provider: string; secretStored: string },
  modelId: string,
): Promise<{ ok: boolean; note: string }> {
  if (!TEXT_PROVIDERS.includes(cred.provider)) return { ok: false, note: 'not a text provider' };
  const base = upstreamBase(cred.provider);
  if (!base) return { ok: false, note: 'no upstream base' };
  try {
    const secret = decryptSecret(cred.secretStored, {
      prisma,
      actor: 'liveness',
      action: 'liveness.ping',
      target: cred.id,
    });
    // google catalogs ids as "models/<id>"; its OpenAI endpoint wants bare ids
    const providerModel = cred.provider === 'google' ? modelId.replace(/^models\//, '') : modelId;
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: providerModel,
        messages: [{ role: 'user', content: '.' }],
        stream: false,
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, note: 'ok' };
    let note = `upstream ${res.status}`;
    try {
      const j: unknown = await res.json();
      const e = (Array.isArray(j) ? j[0] : j) as { error?: { message?: string }; message?: string };
      note = e?.error?.message ?? e?.message ?? note;
    } catch {
      /* keep the status text */
    }
    return { ok: false, note: String(note).slice(0, 200) };
  } catch (e) {
    return { ok: false, note: (e as Error).message.slice(0, 200) };
  }
}

// bounded sweep: probe (pool key × rung model) pairs, oldest-checked first,
// so a full matrix cycles around over successive ticks. Returns probes run.
export async function refreshModelLiveness(
  prisma: PrismaClient,
  orgIds: string[],
  maxProbes = 12,
): Promise<number> {
  if (!orgIds.length) return 0;
  const creds = await prisma.providerCredential
    .findMany({
      where: { orgId: { in: orgIds }, status: 'active', provider: { in: TEXT_PROVIDERS } },
      select: { id: true, provider: true, secretStored: true },
      orderBy: { createdAt: 'asc' },
    })
    .catch(() => []);
  const rungs = await liveRungModels(prisma);
  if (!creds.length || !rungs.length) return 0;

  const pairs: { cred: (typeof creds)[number]; model: string }[] = [];
  for (const r of rungs) {
    for (const c of creds) {
      if (c.provider === r.provider) pairs.push({ cred: c, model: r.providerModelId });
    }
  }
  const last = await prisma.modelLiveness
    .findMany({
      where: { credentialId: { in: creds.map((c) => c.id) } },
      select: { credentialId: true, provider: true, model: true, lastCheckedAt: true },
    })
    .catch(() => []);
  const stamp = new Map(last.map((l) => [`${l.credentialId}|${l.model}`, l.lastCheckedAt.getTime()]));
  pairs.sort(
    (a, b) => (stamp.get(`${a.cred.id}|${a.model}`) ?? 0) - (stamp.get(`${b.cred.id}|${b.model}`) ?? 0),
  );

  let done = 0;
  for (const p of pairs.slice(0, maxProbes)) {
    const { ok, note } = await pingModel(prisma, p.cred, p.model);
    await prisma.modelLiveness
      .upsert({
        where: {
          credentialId_provider_model: { credentialId: p.cred.id, provider: p.cred.provider, model: p.model },
        },
        update: { ok, note, lastCheckedAt: new Date() },
        create: { credentialId: p.cred.id, provider: p.cred.provider, model: p.model, ok, note, lastCheckedAt: new Date() },
      })
      .catch(() => {});
    done += 1;
  }
  return done;
}

export interface RungLiveness {
  provider: string;
  model: string;
  live: number; // fresh checks that serve it
  dead: number; // fresh checks that don't
  total: number; // active pool keys for that provider
  checkedAt: Date | null;
}

// the workbench's question per rung: of the pool keys for this provider, how
// many provably serve this model right now?
export async function livenessForRungs(
  prisma: PrismaClient,
  orgIds: string[],
  rungs: RungRef[],
): Promise<Record<string, RungLiveness>> {
  const out: Record<string, RungLiveness> = {};
  if (!orgIds.length || !rungs.length) return out;
  const creds = await prisma.providerCredential
    .findMany({
      where: { orgId: { in: orgIds }, status: 'active', provider: { in: TEXT_PROVIDERS } },
      select: { id: true, provider: true },
    })
    .catch(() => []);
  const rows = creds.length
    ? await prisma.modelLiveness
        .findMany({ where: { credentialId: { in: creds.map((c) => c.id) } } })
        .catch(() => [] as { provider: string; model: string; ok: boolean; lastCheckedAt: Date }[])
    : [];
  const now = Date.now();
  const fresh = (t: Date) => now - t.getTime() < LIVENESS_TTL_MS;
  for (const r of rungs) {
    const keys = creds.filter((c) => c.provider === r.provider).length;
    const forRung = rows.filter((x) => x.provider === r.provider && x.model === r.providerModelId && fresh(x.lastCheckedAt));
    const live = forRung.filter((x) => x.ok).length;
    const dead = forRung.length - live;
    let checkedAt: Date | null = null;
    for (const x of rows.filter((x) => x.provider === r.provider && x.model === r.providerModelId)) {
      if (!checkedAt || x.lastCheckedAt > checkedAt) checkedAt = x.lastCheckedAt;
    }
    out[`${r.provider}/${r.providerModelId}`] = {
      provider: r.provider,
      model: r.providerModelId,
      live,
      dead,
      total: keys,
      checkedAt,
    };
  }
  return out;
}
