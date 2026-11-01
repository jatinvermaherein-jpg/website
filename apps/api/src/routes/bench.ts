// CREW — bench + fidelity (Phase 10).
//
//   A bench manifest is a SNAPSHOT of the project the seat is on: the rows
//   with their fidelity levels, the latest verdicts, the stream cursor.
//   Resuming is ONE command: the seat names the manifest (or takes the
//   latest), the digest is re-verified — a tampered manifest is refused —
//   and the seat's cursor + view come back from the manifest, not from a
//   re-read of history.
//
//   The fidelity gate itself lives on the stream route: verdicts only run
//   UP the ladder (unit < local-stack < staging < production).
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/append.js';
import { requireUser } from '../lib/auth.js';

function digestOf(parts: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

async function projectRows(projectId: string) {
  const ledger = await prisma.ledgerRow.findMany({ where: { projectId }, orderBy: { ts: 'asc' } });
  const latest = new Map<string, { rowId: string; status: string; environment: string }>();
  for (const r of ledger) latest.set(r.rowId, { rowId: r.rowId, status: r.status, environment: r.environment });
  return [...latest.values()];
}

async function snapshotOf(projectId: string) {
  const rows = await projectRows(projectId);
  const lastEvent = await prisma.event.findFirst({ where: { scopeId: projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });
  const verdictCount = await prisma.verdict.count({ where: { projectId } });
  return { rows, cursor: lastEvent?.seq ? lastEvent.seq.toString() : '0', verdictCount };
}

async function seatContext(slug: string, seatId: string, orgId: string) {
  const project = await prisma.project.findFirst({ where: { slug, orgId } });
  if (!project) return null;
  const seat = await prisma.seat.findFirst({ where: { id: seatId, orgId } });
  if (!seat) return null;
  const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId, projectId: project.id } } });
  if (!joined) return null;
  return { project, seat };
}

async function appendBenchEvent(projectId: string, body: Record<string, unknown>, actor: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await appendEvent({ projectId, type: 'bench', actor, body });
      return;
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002' && attempt < 5) continue;
      throw e;
    }
  }
}

export async function benchRoutes(app: FastifyInstance) {
  // snapshot the seat's bench → a manifest with a digest
  app.post('/:slug/seats/:seatId/bench', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const { slug, seatId } = req.params as { slug: string; seatId: string };
    const ctx = await seatContext(slug, seatId, membership.orgId);
    if (!ctx) return reply.code(404).send({ error: 'no such seat on this project' });

    const b = (req.body ?? {}) as { image?: string; packages?: unknown; restore?: string };
    if (!b.image?.trim() || !b.restore?.trim()) {
      return reply.code(422).send({ error: 'image and restore are required — a manifest that cannot be restored is a manifest that cannot be resumed' });
    }
    const snapshot = await snapshotOf(ctx.project.id);
    const parts = { image: b.image, packages: b.packages ?? null, restore: b.restore, snapshot };
    const digest = digestOf(parts);

    const manifest = await prisma.benchManifest.create({
      data: {
        seatId,
        image: b.image,
        packages: parts as unknown as InputJsonValue, // the digest covers packages + snapshot
        restore: b.restore,
        digest,
      },
    });
    await appendBenchEvent(ctx.project.id, {
      kind: 'manifest',
      seatId,
      manifestId: manifest.id,
      digest,
      rows: snapshot.rows.length,
      cursor: snapshot.cursor,
    }, user.username).catch((e) => console.error('[bench] event write failed', e));

    return reply.code(201).send({ manifestId: manifest.id, digest, snapshot });
  });

  // ONE command: resume from a manifest (or the seat's latest)
  app.post('/:slug/seats/:seatId/resume', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const { slug, seatId } = req.params as { slug: string; seatId: string };
    const ctx = await seatContext(slug, seatId, membership.orgId);
    if (!ctx) return reply.code(404).send({ error: 'no such seat on this project' });

    const b = (req.body ?? {}) as { manifestId?: string };
    const manifest = b.manifestId
      ? await prisma.benchManifest.findFirst({ where: { id: b.manifestId, seatId } })
      : await prisma.benchManifest.findFirst({ where: { seatId }, orderBy: { ts: 'desc' } });
    if (!manifest) return reply.code(404).send({ error: 'no manifest for this seat' });

    // re-verify the digest — the manifest must be exactly what was sealed
    const stored = (manifest.packages ?? {}) as Record<string, unknown>;
    const recomputed = digestOf({
      image: manifest.image,
      packages: stored.packages ?? null,
      restore: manifest.restore,
      snapshot: stored.snapshot,
    });
    if (recomputed !== manifest.digest) {
      return reply.code(409).send({ error: 'manifest digest mismatch — the bench cannot be trusted', manifestId: manifest.id });
    }

    const snapshot = stored.snapshot as { rows: unknown[]; cursor: string; verdictCount: number };
    await prisma.cursor
      .upsert({
        where: { seatId_scopeId: { seatId, scopeId: ctx.project.id } },
        update: { lastSeq: BigInt(snapshot.cursor ?? '0') },
        create: { seatId, scopeId: ctx.project.id, lastSeq: BigInt(snapshot.cursor ?? '0') },
      })
      .catch(() => {});
    await prisma.seat
      .update({ where: { id: seatId }, data: { lastHeartbeat: new Date(), status: ctx.seat.status === 'created' ? 'online' : ctx.seat.status } })
      .catch(() => {});

    await appendBenchEvent(
      ctx.project.id,
      { kind: 'resume', seatId, manifestId: manifest.id, digest: manifest.digest, restored: { cursor: snapshot.cursor, rows: (snapshot.rows as { rowId: string }[]).length } },
      user.username,
    ).catch((e) => console.error('[bench] event write failed', e));

    return {
      resumed: true,
      manifestId: manifest.id,
      digest: manifest.digest,
      restored: {
        cursor: snapshot.cursor,
        rows: snapshot.rows,
        verdictCount: snapshot.verdictCount,
      },
      image: manifest.image,
      restore: manifest.restore,
    };
  });
}
