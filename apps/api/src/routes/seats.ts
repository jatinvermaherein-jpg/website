// SEATS — the real agents on a project. A seat is a NAMED identity on the
// project stream: one key, one seat (the join spine). The key is shown
// exactly once and only the hash is stored — same law as gateway keys.
// Revoke is archive-not-delete: the credential dies, the trail stays.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireUser, requireOperator } from '../lib/auth.js';
import { SEAT_KEY_PREFIX, seatSha256, SEAT_ONLINE_MS } from '../lib/seatauth.js';

const ROLES = ['lead', 'builder', 'auditor', 'scribe', 'scout'] as const;

export async function seatRoutes(app: FastifyInstance) {
  async function orgProject(slug: string, userId: string) {
    const membership = await prisma.membership.findFirst({ where: { userId } });
    if (!membership) return null;
    const project = await prisma.project.findFirst({ where: { slug, orgId: membership.orgId } });
    return project ? { orgId: membership.orgId, project } : null;
  }

  const seatView = (s: { id: string; name: string; role: string; status: string; lastHeartbeat: Date | null; createdAt: Date }) => ({
    id: s.id,
    name: s.name,
    role: s.role,
    status: s.status,
    online: s.lastHeartbeat !== null && Date.now() - s.lastHeartbeat.getTime() < SEAT_ONLINE_MS,
    lastHeartbeat: s.lastHeartbeat ? s.lastHeartbeat.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  });

  // the team on this project
  app.get('/:slug/seats', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const ctx = await orgProject((req.params as { slug: string }).slug, user.id);
    if (!ctx) return reply.code(404).send({ error: 'no such project' });
    const seats = await prisma.seat.findMany({
      where: { orgId: ctx.orgId, status: { not: 'archived' }, projects: { some: { projectId: ctx.project.id } } },
      orderBy: { createdAt: 'asc' },
    });
    return { project: ctx.project.slug, seats: seats.map(seatView) };
  });

  // open a seat — the agent's identity + credential, key shown exactly once.
  // D2: issuing a credential is an operator act. Any member could previously
  // mint an `auditor` seat, list every seat, or revoke one — the dashboard
  // hid the panel, the API did not care. Authorisation belongs in the API.
  app.post('/:slug/seats', async (req, reply) => {
    const user = await requireOperator(req, reply);
    if (!user) return;
    const ctx = await orgProject((req.params as { slug: string }).slug, user.id);
    if (!ctx) return reply.code(404).send({ error: 'no such project' });
    const parsed = z
      .object({ name: z.string().min(1).max(40), role: z.enum(ROLES).default('builder') })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid seat' });
    const name = parsed.data.name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    // the stream is a named room — one identity per name per project
    const dup = await prisma.seat.findFirst({
      where: { orgId: ctx.orgId, name, projects: { some: { projectId: ctx.project.id } } },
    });
    if (dup) return reply.code(409).send({ error: 'a seat with that name is already on this project' });

    const seat = await prisma.seat.create({ data: { orgId: ctx.orgId, name, role: parsed.data.role } });
    await prisma.seatProject.create({ data: { seatId: seat.id, projectId: ctx.project.id } });
    const plaintext = SEAT_KEY_PREFIX + randomBytes(32).toString('base64url');
    await prisma.seatKey.create({ data: { seatId: seat.id, keyHash: seatSha256(plaintext) } });
    return reply.code(201).send({ seat: seatView(seat), key: plaintext, keyMask: plaintext.slice(0, 10) + '…' });
  });

  // revoke — the credential dies, the seat goes vacant, the trail stays.
  // D2: revoking a credential is an operator act.
  app.post('/:slug/seats/:seatId/revoke', async (req, reply) => {
    const user = await requireOperator(req, reply);
    if (!user) return;
    const { slug, seatId } = req.params as { slug: string; seatId: string };
    const ctx = await orgProject(slug, user.id);
    if (!ctx) return reply.code(404).send({ error: 'no such project' });
    const seat = await prisma.seat.findFirst({ where: { id: seatId, orgId: ctx.orgId } });
    if (!seat) return reply.code(404).send({ error: 'no such seat' });
    await prisma.seatKey.updateMany({ where: { seatId }, data: { revokedAt: new Date() } });
    await prisma.session.updateMany({ where: { seatId }, data: { expiresAt: new Date() } });
    await prisma.seat.update({ where: { id: seat.id }, data: { status: 'vacant' } });
    return { id: seat.id, status: 'vacant' };
  });
}
