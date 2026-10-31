// O2 — account-based usage, per key, with custom per-key limits.
// Law 6.3: keys are write-only. The secret is encrypted at write time and
// no read path ever returns it — only the mask.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { encryptSecret } from '../lib/vault.js';
import { TEXT_PROVIDERS } from '../lib/upstream.js';

// Operator's provider stack (2026-10-29, supersedes D1's "Big Five"):
//   text/reasoning: google (Gemini) · groq · openrouter (free models —
//     DeepSeek R1 reachable here via :free, no separate key — DeepSeek's
//     own API has no free tier as of Oct 2026) · mistral
//   web search:     tavily · serper
//   image:          pollinations (legacy no-key endpoint)
const PROVIDERS = ['google', 'groq', 'openrouter', 'mistral', 'tavily', 'serper', 'pollinations'] as const;
type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_CATEGORY: Record<Provider, 'text' | 'search' | 'image'> = {
  google: 'text',
  groq: 'text',
  openrouter: 'text',
  mistral: 'text',
  tavily: 'search',
  serper: 'search',
  pollinations: 'image',
};

const LIMIT_KINDS = ['rpm', 'tpm', 'rpd', 'monthly_tokens', 'monthly_cost_cents'] as const;

const limitSchema = z.object({
  kind: z.enum(LIMIT_KINDS),
  limit: z.number().positive().nullable(),
  reservePct: z.number().int().min(0).max(50).default(5),
});

// Self-protecting defaults — the operator adds a key and does NOT type its
// limits; the API applies them per category. Anything passed explicitly in
// the request overrides the matching default.
const DEFAULT_KEY_LIMITS: Record<'text' | 'search' | 'image', { kind: (typeof LIMIT_KINDS)[number]; limit: number }[]> = {
  text: [
    { kind: 'rpm', limit: 60 },
    { kind: 'tpm', limit: 500_000 },
    { kind: 'rpd', limit: 20_000 },
    { kind: 'monthly_tokens', limit: 200_000_000 },
    { kind: 'monthly_cost_cents', limit: 10_000 },
  ],
  search: [
    { kind: 'rpm', limit: 30 },
    { kind: 'rpd', limit: 5_000 },
    { kind: 'monthly_cost_cents', limit: 2_000 },
  ],
  image: [
    { kind: 'rpm', limit: 30 },
    { kind: 'rpd', limit: 2_000 },
  ],
};

const addKeySchema = z
  .object({
    provider: z.enum(PROVIDERS),
    label: z.string().min(1).max(64),
    // pollinations' legacy endpoint needs no key
    secret: z.string().min(1).max(512).optional(),
    // O1: projectId set → the project's own key (not the org's Flow pool)
    projectId: z.string().cuid().nullable().optional(),
    limits: z.array(limitSchema).max(10).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.provider !== 'pollinations' && !v.secret) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secret'], message: 'secret required for this provider' });
    }
  });

async function orgOf(userId: string) {
  return prisma.membership.findFirst({ where: { userId }, include: { org: true } });
}

function publicView(cred: {
  id: string;
  provider: string;
  label: string;
  keyMask: string;
  status: string;
  projectId: string | null;
  createdAt: Date;
  limits: { kind: string; limit: number | null; reservePct: number }[];
}) {
  return {
    id: cred.id,
    provider: cred.provider,
    category: PROVIDER_CATEGORY[cred.provider as Provider] ?? 'text',
    label: cred.label,
    keyMask: cred.keyMask,
    status: cred.status,
    projectId: cred.projectId,
    createdAt: cred.createdAt,
    limits: cred.limits.map((l) => ({ kind: l.kind, limit: l.limit, reservePct: l.reservePct })),
  };
}

export async function accountRoutes(app: FastifyInstance) {
  app.get('/keys', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const creds = await prisma.providerCredential.findMany({
      where: { orgId: membership.orgId },
      include: { limits: true },
      orderBy: { createdAt: 'asc' },
    });
    return { keys: creds.map(publicView) };
  });

  app.post('/keys', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const parsed = addKeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid key' });
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const { provider, label, secret, projectId, limits } = parsed.data;

    if (projectId) {
      const project = await prisma.project.findFirst({ where: { id: projectId, orgId: membership.orgId } });
      if (!project) return reply.code(404).send({ error: 'project not found in your org' });
    }

    const { stored, keyMask } = secret ? encryptSecret(secret) : { stored: '', keyMask: 'no-key' };
    const cred = await prisma.providerCredential.create({
      data: { orgId: membership.orgId, projectId: projectId ?? null, provider, label, secretStored: stored, keyMask },
    });
    for (const l of limits) {
      await prisma.keyLimit.upsert({
        where: { credentialId_kind: { credentialId: cred.id, kind: l.kind } },
        update: { limit: l.limit, reservePct: l.reservePct },
        create: { credentialId: cred.id, kind: l.kind, limit: l.limit, reservePct: l.reservePct },
      });
    }
    // auto-apply the per-category defaults when the operator typed NONE —
    // typed limits are exact (no mixing), so the pool always knows its
    // numbers either way
    if (!limits.length) {
      const category = PROVIDER_CATEGORY[provider as Provider] ?? 'text';
      for (const d of DEFAULT_KEY_LIMITS[category]) {
        await prisma.keyLimit.upsert({
          where: { credentialId_kind: { credentialId: cred.id, kind: d.kind } },
          update: { limit: d.limit, reservePct: 5 },
          create: { credentialId: cred.id, kind: d.kind, limit: d.limit, reservePct: 5 },
        });
      }
    }
    return reply.code(201).send({ id: cred.id, provider, label, keyMask, projectId: projectId ?? null });
  });

  // Phase 5 — revoke: archive-not-delete. The row (and the trail that
  // references it) stays; the pool simply stops containing the key.
  app.post('/keys/:id/revoke', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const cred = await prisma.providerCredential.findFirst({ where: { id, orgId: membership.orgId } });
    if (!cred) return reply.code(404).send({ error: 'key not found' });
    if (cred.status === 'revoked') return { id, status: 'revoked', note: 'already revoked' };
    await prisma.providerCredential.update({ where: { id }, data: { status: 'revoked' } });
    return { id, status: 'revoked' };
  });

  app.get('/projects', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const projects = await prisma.project.findMany({
      where: { orgId: membership.orgId },
      orderBy: { createdAt: 'asc' },
      select: { slug: true, name: true, status: true, createdAt: true },
    });
    return { projects };
  });

  // Phase 4 — org aliases: an ordered list of provider targets the gateway
  // walks when the model is requested by alias (≤4 hops).
  const aliasTargetSchema = z.object({
    provider: z.enum(TEXT_PROVIDERS),
    providerModelId: z.string().min(1).max(200),
    priority: z.number().int().min(0).max(10000).optional(),
    priceInPerM: z.number().min(0).max(1e6).optional(),
    priceOutPerM: z.number().min(0).max(1e6).optional(),
    ctxWindow: z.number().int().min(1).max(10_000_000).optional(),
  });
  const aliasSchema = z.object({
    alias: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
    targets: z.array(aliasTargetSchema).min(1).max(5),
  });

  app.post('/aliases', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const parsed = aliasSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: 'invalid alias' });
    const { alias, targets } = parsed.data;

    // replace-on-write: the alias's previous targets go away atomically-ish
    await prisma.modelAlias.deleteMany({ where: { orgId: membership.orgId, alias } });
    const created: unknown[] = [];
    for (const [i, t] of targets.entries()) {
      const model = await prisma.model.upsert({
        where: { provider_providerModelId: { provider: t.provider, providerModelId: t.providerModelId } },
        update: {
          ...(t.priceInPerM !== undefined ? { priceInPerM: t.priceInPerM } : {}),
          ...(t.priceOutPerM !== undefined ? { priceOutPerM: t.priceOutPerM } : {}),
          ...(t.ctxWindow !== undefined ? { ctxWindow: t.ctxWindow } : {}),
        },
        create: {
          provider: t.provider,
          providerModelId: t.providerModelId,
          priceInPerM: t.priceInPerM ?? 0,
          priceOutPerM: t.priceOutPerM ?? 0,
          ctxWindow: t.ctxWindow ?? 8192,
        },
      });
      const row = await prisma.modelAlias.create({
        data: { orgId: membership.orgId, alias, modelId: model.id, priority: t.priority ?? i * 10 },
      });
      created.push({ priority: row.priority, provider: t.provider, providerModelId: t.providerModelId });
    }
    return reply.code(201).send({ alias, targets: created });
  });

  app.get('/aliases', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const aliases = await prisma.modelAlias.findMany({
      where: { orgId: membership.orgId },
      orderBy: [{ alias: 'asc' }, { priority: 'asc' }],
    });
    const models = await prisma.model.findMany({ where: { id: { in: aliases.map((a) => a.modelId) } } });
    const byId = new Map(models.map((m) => [m.id, m]));
    const grouped = new Map<string, { alias: string; targets: { priority: number; provider: string; providerModelId: string }[] }>();
    for (const a of aliases) {
      const m = byId.get(a.modelId);
      if (!m) continue;
      if (!grouped.has(a.alias)) grouped.set(a.alias, { alias: a.alias, targets: [] });
      grouped.get(a.alias)!.targets.push({ priority: a.priority, provider: m.provider, providerModelId: m.providerModelId });
    }
    const values = [...grouped.values()];
    // opacity: a customer sees the model NAMES they may call — never the
    // provider or model id behind them. Exception: a BYO account (the org
    // holds its own provider keys) may see the targets IT assigned.
    if (!user.isOperator) {
      const hasOwnKeys = (await prisma.providerCredential.count({ where: { orgId: membership.orgId } })) > 0;
      if (!hasOwnKeys) return { aliases: values.map((v) => ({ alias: v.alias })) };
    }
    return { aliases: values };
  });

  // the account's own limit windows — what the operator set, and how much
  // has been used in each window right now (the member's "your limits")
  app.get('/limits', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const { orgWindows } = await import('../lib/quota.js');
    return { orgWindows: await orgWindows(prisma, membership.orgId) };
  });

  app.patch('/keys/:id/limits', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const cred = await prisma.providerCredential.findFirst({ where: { id, orgId: membership.orgId } });
    if (!cred) return reply.code(404).send({ error: 'key not found' });

    const parsed = z.object({ limits: z.array(limitSchema).max(10) }).safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid limits' });

    for (const l of parsed.data.limits) {
      await prisma.keyLimit.upsert({
        where: { credentialId_kind: { credentialId: cred.id, kind: l.kind } },
        update: { limit: l.limit, reservePct: l.reservePct },
        create: { credentialId: cred.id, kind: l.kind, limit: l.limit, reservePct: l.reservePct },
      });
    }
    const fresh = await prisma.providerCredential.findUniqueOrThrow({ where: { id: cred.id }, include: { limits: true } });
    return publicView(fresh);
  });
}
