// O2 — account-based usage, per key, with custom per-key limits.
// Law 6.3: keys are write-only. The secret is encrypted at write time and
// no read path ever returns it — only the mask.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { encryptSecret } from '../lib/vault.js';

const PROVIDERS = ['openai', 'anthropic', 'google', 'groq', 'openrouter'] as const;
const LIMIT_KINDS = ['rpm', 'tpm', 'rpd', 'monthly_tokens', 'monthly_cost_cents'] as const;

const limitSchema = z.object({
  kind: z.enum(LIMIT_KINDS),
  limit: z.number().positive().nullable(),
  reservePct: z.number().int().min(0).max(50).default(5),
});

const addKeySchema = z.object({
  provider: z.enum(PROVIDERS),
  label: z.string().min(1).max(64),
  secret: z.string().min(8).max(512),
  // O1: projectId set → the project's own key (not the org's Flow pool)
  projectId: z.string().cuid().nullable().optional(),
  limits: z.array(limitSchema).max(10).default([]),
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
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid key' });
    const membership = await orgOf(user.id);
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const { provider, label, secret, projectId, limits } = parsed.data;

    if (projectId) {
      const project = await prisma.project.findFirst({ where: { id: projectId, orgId: membership.orgId } });
      if (!project) return reply.code(404).send({ error: 'project not found in your org' });
    }

    const { stored, keyMask } = encryptSecret(secret);
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
    return reply.code(201).send({ id: cred.id, provider, label, keyMask, projectId: projectId ?? null });
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
