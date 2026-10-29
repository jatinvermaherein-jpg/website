// O3 — the operator verifies pending accounts from here.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireOperator } from '../lib/auth.js';

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
}
