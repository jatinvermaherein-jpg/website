// CREW — the one typed stream per project (Phase 6).
//
//   POST /api/projects/:slug/stream   — validate AT POST. A malformed line is
//                                       refused with its violations and is
//                                       never written. seq is assigned
//                                       atomically (serializable tx + retry).
//                                       A verdict line is demoted per the D8
//                                       law (no falsification / no instrument
//                                       control → unproven) and mirrored into
//                                       a Verdict row.
//   GET  /api/projects/:slug/stream   — fail OPEN on read: a line the reader
//                                       cannot validate is returned flagged
//                                       `corrupt: true`; the stream never
//                                       blocks. Cursor = last-seen seq per
//                                       seat (the authenticated user).
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { validateEvent, coerceVerdict, ENV_RANK, type EventType } from '../lib/envelope.js';

const MAX_TAKE = 200;

async function projectOf(orgId: string, slug: string) {
  return prisma.project.findFirst({ where: { slug, orgId } });
}

function eventView(ev: {
  id: string;
  scopeId: string;
  seq: bigint;
  type: string;
  actor: string;
  at: Date;
  refs: unknown;
  body: unknown;
  envelopeVersion: number;
}): Record<string, unknown> {
  const corrupt = validateEvent(ev.type, ev.actor, ev.body).length > 0;
  return {
    v: ev.envelopeVersion,
    scopeId: ev.scopeId,
    seq: ev.seq.toString(),
    type: ev.type,
    actor: ev.actor,
    ts: ev.at.toISOString(),
    body: ev.body,
    refs: ev.refs ?? undefined,
    ...(corrupt ? { corrupt: true } : {}),
  };
}

async function appendEvent(projectId: string, type: EventType, actor: string, body: unknown, refs?: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const last = await tx.event.findFirst({ where: { scopeId: projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });
          const seq = (last?.seq ?? 0n) + 1n;
          let finalBody: unknown = body;
          if (type === 'verdict') {
            const v = body as Record<string, unknown>;
            const { verdict, coerced } = coerceVerdict(v);
            finalBody = { ...v, verdict, coerced };
            await tx.verdict.create({
              data: {
                projectId,
                rowId: v.rowId as string,
                seat: v.seat as string,
                direction: v.direction as string,
                environment: v.environment as string,
                fidelity: typeof v.fidelity === 'number' ? v.fidelity : 0,
                verdict,
                evidence: v.evidence as InputJsonValue,
                falsification: (v.falsification as InputJsonValue | undefined) ?? undefined,
                instrumentControl: (v.instrumentControl as InputJsonValue | undefined) ?? undefined,
                witnessDigest: (v.witnessDigest as string | undefined) ?? undefined,
                attestedNotWitnessed: v.attestedNotWitnessed === false ? false : true,
                benchDigest: (v.benchDigest as string | undefined) ?? undefined,
              },
            });
          }
          return tx.event.create({
            data: {
              scopeId: projectId,
              projectId,
              seq,
              type,
              actor,
              body: finalBody as InputJsonValue,
              refs: (refs ?? undefined) as InputJsonValue | undefined,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      // P2002 = two writers claimed the same seq — the serializable tx may
      // still let one through; retry with a fresh max
      if ((e as { code?: string })?.code === 'P2002' && attempt < 5) continue;
      throw e;
    }
  }
}

export async function streamRoutes(app: FastifyInstance) {
  // read — fail open, cursor-resuming
  app.get('/:slug/stream', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const project = await projectOf(membership.orgId, (req.params as { slug: string }).slug);
    if (!project) return reply.code(404).send({ error: 'no such project' });

    const q = req.query as { afterSeq?: string; limit?: string };
    let cursor = 0n;
    if (q.afterSeq !== undefined) {
      if (!/^\d+$/.test(q.afterSeq)) return reply.code(422).send({ error: 'afterSeq must be a non-negative integer' });
      cursor = BigInt(q.afterSeq);
    } else {
      const saved = await prisma.cursor.findUnique({ where: { seatId_scopeId: { seatId: user.id, scopeId: project.id } } });
      cursor = saved?.lastSeq ?? 0n;
    }
    const limit = Math.min(MAX_TAKE, Math.max(1, Number(q.limit) || 50));

    const events = await prisma.event.findMany({
      where: { scopeId: project.id, seq: { gt: cursor } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    const nextCursor = events.length ? events[events.length - 1]!.seq : cursor;

    await prisma.cursor
      .upsert({
        where: { seatId_scopeId: { seatId: user.id, scopeId: project.id } },
        update: { lastSeq: nextCursor },
        create: { seatId: user.id, scopeId: project.id, lastSeq: nextCursor },
      })
      .catch(() => {});

    return {
      project: project.slug,
      events: events.map(eventView),
      cursor: cursor.toString(),
      nextCursor: nextCursor.toString(),
    };
  });

  // post — validate at post; the bad line is refused, never written
  app.post('/:slug/stream', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const project = await projectOf(membership.orgId, (req.params as { slug: string }).slug);
    if (!project) return reply.code(404).send({ error: 'no such project' });

    const b = (req.body ?? {}) as { type?: string; actor?: string; body?: unknown; refs?: Record<string, unknown> };
    const type = b.type as EventType;
    const actor = typeof b.actor === 'string' && b.actor.trim() ? b.actor : user.username;
    const violations = validateEvent(String(type), actor, b.body);

    // Phase 10 — the fidelity ladder: verdicts only run UP. A row that
    // demands production refuses a local-stack verdict, no matter who posts
    // it. (Applies when the row exists on the join spine; verdicts on
    // unregistered rows are unconstrained — they are attested, not decided.)
    if (type === 'verdict' && b.body && typeof b.body === 'object' && !Array.isArray(b.body)) {
      const v = b.body as Record<string, unknown>;
      if (typeof v.rowId === 'string' && typeof v.environment === 'string') {
        const row = await prisma.ledgerRow.findFirst({
          where: { projectId: project.id, rowId: v.rowId },
          orderBy: { ts: 'desc' },
        });
        if (row && (ENV_RANK[v.environment] ?? -1) < (ENV_RANK[row.environment] ?? -1)) {
          return reply.code(422).send({
            error: `a ${row.environment} row refuses a ${v.environment} verdict — fidelity only runs upward`,
          });
        }
      }
    }

    if (violations.length) {
      // the bad line is NEVER written — but the refusal is telemetry
      // (law: rejections are visible; the same refusal reason twice =
      // schema defect, which needs the record to be counted). The system
      // event describing the refusal is a WELL-FORMED line about the
      // malformed one.
      await appendEvent(project.id, 'system', 'stream-gate', {
        rejection: true,
        type: String(type),
        actor,
        violations,
        at: new Date().toISOString(),
      }).catch((e) => console.error('[stream] rejection telemetry failed', e));
      return reply.code(422).send({ error: 'rejected at post — the line is malformed and was not written', violations });
    }

    const ev = await appendEvent(project.id, type, actor, b.body, b.refs);
    const { verdict, coerced } = type === 'verdict' ? coerceVerdict(b.body as Record<string, unknown>) : { verdict: null, coerced: [] };

    return reply.code(201).send({
      project: project.slug,
      seq: ev.seq.toString(),
      type: ev.type,
      ...(type === 'verdict' ? { verdict, coerced } : {}),
    });
  });
}
