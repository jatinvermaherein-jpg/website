// O3 — the operator verifies pending accounts from here, and runs the
// resale desk: every account's usage limits (the numbers that all of the
// account's keys pool into) and its model assignments (which aliases the
// customer may call, and what stands behind them).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireOperator } from '../lib/auth.js';
import { ORG_LIMIT_KINDS } from '../lib/quota.js';

const limitSchema = z.object({
  // null / omitted = the whole account; otherwise the model name the
  // customer calls (an alias, or the service names 'search' / 'image')
  model: z.string().min(1).max(64).nullable().optional(),
  kind: z.enum(ORG_LIMIT_KINDS),
  limit: z.number().positive().nullable(),
  reservePct: z.number().int().min(0).max(50).default(5),
});

// org of the user's OWN account (registration makes the user the owner of
// a personal org)
async function orgOf(userId: string) {
  return prisma.membership.findFirst({ where: { userId }, include: { org: true } });
}

const TEXT_PROVIDERS = ['google', 'groq', 'openrouter', 'mistral'] as const;
const aliasTargetSchema = z.object({
  provider: z.enum(TEXT_PROVIDERS),
  providerModelId: z.string().min(1).max(200),
  priority: z.number().int().min(0).max(10000).optional(),
});
const aliasSchema = z.object({
  alias: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
  targets: z.array(aliasTargetSchema).min(1).max(5),
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/pending', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const users = await prisma.user.findMany({
      where: { status: 'pending' },
      select: { id: true, username: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return { pending: users };
  });

  app.post('/users/:id/verify', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    if (target.status !== 'pending') return reply.code(409).send({ error: `user is ${target.status}, not pending` });

    await prisma.user.update({
      where: { id },
      data: { status: 'active', verifiedBy: op.id, verifiedAt: new Date() },
    });
    await prisma.verification.create({
      data: { pendingUserId: id, byId: op.id, decision: 'approved' },
    });
    return { username: target.username, status: 'active' };
  });

  app.post('/users/:id/suspend', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    await prisma.user.update({ where: { id }, data: { status: 'suspended' } });
    await prisma.verification.create({
      data: { pendingUserId: id, byId: op.id, decision: 'rejected', note: 'suspended' },
    });
    return { username: target.username, status: 'suspended' };
  });

  // the full account book — for the limits/models desk
  app.get('/users', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, username: true, status: true, isOperator: true, createdAt: true } });
    const members = await prisma.membership.findMany({ include: { org: { select: { id: true, name: true } } } });
    const orgByUser = new Map(members.map((m) => [m.userId, m.org]));
    const keys = await prisma.apiKey.groupBy({ by: ['orgId'], _count: { _all: true } });
    const keysByOrg = new Map(keys.map((k) => [k.orgId, k._count._all]));
    const requests = await prisma.request.groupBy({ by: ['orgId'], _count: { _all: true }, _sum: { costCents: true } });
    const usageByOrg = new Map(requests.map((r) => [r.orgId, { requests: r._count._all, costCents: r._sum.costCents ?? 0 }]));
    return {
      users: users.map((u) => {
        const org = orgByUser.get(u.id);
        const usage = org ? usageByOrg.get(org.id) : undefined;
        return {
          id: u.id,
          username: u.username,
          status: u.status,
          isOperator: u.isOperator,
          createdAt: u.createdAt,
          org: org ? { id: org.id, name: org.name } : null,
          gatewayKeys: org ? (keysByOrg.get(org.id) ?? 0) : 0,
          usage: usage ?? { requests: 0, costCents: 0 },
        };
      }),
    };
  });

  // ── account limits: the numbers every key of the account pools into ──
  app.get('/users/:id/limits', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    const m = await orgOf(target.id);
    if (!m) return reply.code(404).send({ error: 'no org' });
    const rows = await prisma.orgLimit.findMany({ where: { orgId: m.orgId } });
    // the scopes the operator can limit: the whole account, the 'search'
    // and 'image' faces, and every alias assigned to the account
    const aliases = await prisma.modelAlias.findMany({ where: { orgId: m.orgId }, select: { alias: true }, distinct: ['alias'] });
    const scopes = [null, 'search', 'image', ...aliases.map((a) => a.alias)];
    const cell = (scope: string | null, kind: string) => {
      const row = rows.find((r) => (r.model ?? null) === scope && r.kind === kind);
      return { model: scope, kind, limit: row?.limit ?? null, reservePct: row?.reservePct ?? 5 };
    };
    return {
      org: { id: m.orgId, name: m.org.name },
      scopes,
      limits: scopes.flatMap((scope) => ORG_LIMIT_KINDS.map((kind) => cell(scope, kind))),
    };
  });

  app.put('/users/:id/limits', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    const m = await orgOf(target.id);
    if (!m) return reply.code(404).send({ error: 'no org' });

    const parsed = z.object({ limits: z.array(limitSchema).max(100) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: 'invalid limits' });

    await prisma.orgLimit.deleteMany({ where: { orgId: m.orgId } });
    for (const l of parsed.data.limits) {
      if (l.limit === null) continue; // blank = unlimited
      await prisma.orgLimit.create({
        data: { orgId: m.orgId, model: l.model ?? null, kind: l.kind, limit: l.limit, reservePct: l.reservePct },
      });
    }
    const rows = await prisma.orgLimit.findMany({ where: { orgId: m.orgId } });
    return {
      username: target.username,
      limits: rows.map((r) => ({ model: r.model, kind: r.kind, limit: r.limit, reservePct: r.reservePct })),
    };
  });

  // ── account models: the aliases the customer may call + the targets ──
  app.get('/users/:id/aliases', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    const m = await orgOf(target.id);
    if (!m) return reply.code(404).send({ error: 'no org' });
    const aliases = await prisma.modelAlias.findMany({
      where: { orgId: m.orgId },
      orderBy: [{ alias: 'asc' }, { priority: 'asc' }],
    });
    const models = await prisma.model.findMany({ where: { id: { in: aliases.map((a) => a.modelId) } } });
    const byId = new Map(models.map((mm) => [mm.id, mm]));
    const grouped = new Map<string, { alias: string; targets: { priority: number; provider: string; providerModelId: string }[] }>();
    for (const a of aliases) {
      const mm = byId.get(a.modelId);
      if (!mm) continue;
      if (!grouped.has(a.alias)) grouped.set(a.alias, { alias: a.alias, targets: [] });
      grouped.get(a.alias)!.targets.push({ priority: a.priority, provider: mm.provider, providerModelId: mm.providerModelId });
    }
    return { aliases: [...grouped.values()] };
  });

  app.put('/users/:id/aliases', async (req, reply) => {
    const op = await requireOperator(req, reply);
    if (!op) return;
    const { id } = req.params as { id: string };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return reply.code(404).send({ error: 'no such user' });
    const m = await orgOf(target.id);
    if (!m) return reply.code(404).send({ error: 'no org' });
    const parsed = aliasSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid alias' });
    const { alias, targets } = parsed.data;

    await prisma.modelAlias.deleteMany({ where: { orgId: m.orgId, alias } });
    const created: unknown[] = [];
    for (const [i, t] of targets.entries()) {
      const model = await prisma.model.upsert({
        where: { provider_providerModelId: { provider: t.provider, providerModelId: t.providerModelId } },
        update: {},
        create: { provider: t.provider, providerModelId: t.providerModelId },
      });
      const row = await prisma.modelAlias.create({
        data: { orgId: m.orgId, alias, modelId: model.id, priority: t.priority ?? i * 10 },
      });
      created.push({ priority: row.priority, provider: t.provider, providerModelId: t.providerModelId });
    }
    return { alias, targets: created };
  });
}
