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
//
// Hardening 2026-11-01:
//   D1  a seat CANNOT speak as another name. `actor` is forced to the seat's
//       own name and an attempt to set anything else is refused (422). The
//       protocol doc always claimed this; the code now enforces it.
//   D3  ADMISSION is enforced. A seat that has not admitted itself may read,
//       ask questions, and declare — it may NOT file verdicts, tasks or
//       ledger rows. Joining grants attention, not authority.
//   D4  cursor ids are namespaced (`seat:<id>` / `user:<id>`) so the two id
//       spaces can never collide.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { seatFromBearer, touchSeat } from '../lib/seatauth.js';
import { validateEvent, coerceVerdict, ENV_RANK, type EventType } from '../lib/envelope.js';
import { appendEvent, appendQuietly } from '../lib/append.js';

const MAX_TAKE = 200;

// D3 — what a seat may post BEFORE it has admitted itself. Everything else
// is authority, and authority is earned by declaring yourself first.
const PRE_ADMISSION_TYPES = new Set<string>(['admission', 'message', 'answer', 'correction', 'presence', 'system']);

// D7 — the gate that decides must never be the gate the agent wrote.
// A builder produces the work; it does not grade it. Only an auditor (or a
// lead, who directs the run) may file a verdict.
const VERDICT_ROLES = new Set<string>(['auditor', 'lead']);

export type Admission = { takes: string; stale: string; doesNotUnderstand: string };

// A declaration is only an admission if it actually declares something:
// what it is taking, what it believes is stale, and what it does not
// understand. "ok" is not an admission, it is a greeting.
export function validateAdmission(body: unknown): string[] {
  const errs: string[] = [];
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return ['admission body must be an object'];
  const b = body as Record<string, unknown>;
  const need = (k: string, min = 3) => {
    const v = b[k];
    if (typeof v !== 'string' || v.trim().length < min) errs.push(`${k} must be a string of at least ${min} characters`);
  };
  need('takes');
  need('stale');
  need('doesNotUnderstand');
  return errs;
}

// D4 — one cursor column, two id spaces. Namespace them.
const seatCursorId = (seatId: string) => `seat:${seatId}`;
const userCursorId = (userId: string) => `user:${userId}`;

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

export async function streamRoutes(app: FastifyInstance) {
  // read — fail open, cursor-resuming
  app.get('/:slug/stream', async (req, reply) => {
    // one stream, two readers: a real agent (seat credential, from anywhere)
    // or a human (web session). The seat's admission IS its SeatProject row.
    const slug = (req.params as { slug: string }).slug;
    const seat = await seatFromBearer(req);
    let project: { id: string; slug: string } | null = null;
    let cursorId = '';
    if (seat) {
      const p = await prisma.project.findUnique({ where: { slug } });
      const joined = p && (await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: p.id } } }));
      if (!p || !joined) return reply.code(404).send({ error: 'no such project for this seat' });
      project = p;
      cursorId = seatCursorId(seat.id); // D4
      touchSeat(seat.id); // read = heartbeat
    } else {
      const user = await requireUser(req, reply);
      if (!user) return;
      const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
      if (!membership) return reply.code(404).send({ error: 'no org' });
      const p = await projectOf(membership.orgId, slug);
      if (!p) return reply.code(404).send({ error: 'no such project' });
      project = p;
      cursorId = userCursorId(user.id); // D4
    }

    const q = req.query as { afterSeq?: string; limit?: string };
    let cursor = 0n;
    if (q.afterSeq !== undefined) {
      if (!/^\d+$/.test(q.afterSeq)) return reply.code(422).send({ error: 'afterSeq must be a non-negative integer' });
      cursor = BigInt(q.afterSeq);
    } else {
      const saved = await prisma.cursor.findUnique({ where: { seatId_scopeId: { seatId: cursorId, scopeId: project.id } } });
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
        where: { seatId_scopeId: { seatId: cursorId, scopeId: project.id } },
        update: { lastSeq: nextCursor },
        create: { seatId: cursorId, scopeId: project.id, lastSeq: nextCursor },
      })
      .catch(() => {});

    return {
      project: project.slug,
      events: events.map(eventView),
      cursor: cursor.toString(),
      nextCursor: nextCursor.toString(),
      // a seat that has never admitted itself is told so on every read,
      // because the next thing it tries to do is probably a write.
      ...(seat ? { seat: { name: seat.name, role: seat.role, admitted: seat.admittedAt !== null } } : {}),
    };
  });

  // post — validate at post; the bad line is refused, never written
  app.post('/:slug/stream', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const seat = await seatFromBearer(req);
    let project: { id: string; slug: string } | null = null;
    let humanActor: string | null = null;
    if (seat) {
      const p = await prisma.project.findUnique({ where: { slug } });
      const joined = p && (await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: p.id } } }));
      if (!p || !joined) return reply.code(404).send({ error: 'no such project for this seat' });
      project = p;
      touchSeat(seat.id); // post = heartbeat
    } else {
      const user = await requireUser(req, reply);
      if (!user) return;
      const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
      if (!membership) return reply.code(404).send({ error: 'no org' });
      const p = await projectOf(membership.orgId, slug);
      if (!p) return reply.code(404).send({ error: 'no such project' });
      project = p;
      humanActor = user.username;
    }

    const b = (req.body ?? {}) as { type?: string; actor?: string; body?: unknown; refs?: Record<string, unknown> };
    const type = b.type as EventType;
    const claimedActor = typeof b.actor === 'string' && b.actor.trim() ? b.actor.trim() : null;

    // D1 — a seat speaks only as itself. No exceptions, no override.
    if (seat) {
      if (claimedActor && claimedActor !== seat.name) {
        return reply.code(422).send({
          error: `a seat cannot speak as another name — this credential is "${seat.name}", not "${claimedActor}"`,
          rule: 'D1: actor is the credential, never a field',
        });
      }
    }
    const actor = seat ? seat.name : claimedActor ?? humanActor!;

    // D3 — admission before authority.
    if (seat && type !== 'admission' && !seat.admittedAt && !PRE_ADMISSION_TYPES.has(String(type))) {
      return reply.code(409).send({
        error: `seat "${seat.name}" has not admitted itself — a "${type}" line is authority, and admission comes first`,
        how: 'POST {"type":"admission","body":{"takes":"<what you are taking>","stale":"<what you believe is stale>","doesNotUnderstand":"<what you do not understand>"}}',
        allowedBeforeAdmission: [...PRE_ADMISSION_TYPES],
        rule: 'D3: joining grants attention, not authority',
      });
    }

    // D7 — role authority on verdicts, and the verdict's OWN `seat` field.
    // D1 pinned `actor` to the credential; the verdict body carries a second,
    // independent `seat` field that is written straight into the Verdict row.
    // Left unchecked, a builder could file a verdict that the ledger attributed
    // to the auditor.
    if (seat && type === 'verdict') {
      if (!VERDICT_ROLES.has(seat.role)) {
        return reply.code(403).send({
          error: `a ${seat.role} does not file verdicts — a builder produces work, an auditor decides whether it holds`,
          rule: 'D7: the gate that decides must never be the gate the agent wrote',
        });
      }
      const v = (b.body ?? {}) as Record<string, unknown>;
      if (typeof v.seat === 'string' && v.seat !== seat.name) {
        return reply.code(422).send({
          error: `a verdict is filed under your own seat — this credential is "${seat.name}", not "${v.seat}"`,
          rule: 'D1: the payload cannot name a different seat than the credential',
        });
      }
    }

    if (type === 'admission') {
      const admissionErrs = validateAdmission(b.body);
      if (admissionErrs.length) {
        return reply.code(422).send({ error: 'an admission must actually declare something', violations: admissionErrs });
      }
    }

    // THREADS — a reply must point at a line that exists. A dangling replyTo
    // would make a thread walk off into nothing, so it is refused at post.
    let refs = b.refs;
    const rawRefs = (b.refs ?? {}) as Record<string, unknown>;
    let replyActor: string | undefined;
    if (rawRefs.replyTo !== undefined) {
      const target = String(rawRefs.replyTo);
      if (!/^\d+$/.test(target)) return reply.code(422).send({ error: 'refs.replyTo must be the seq of an existing line' });
      const parent = await prisma.event.findFirst({ where: { projectId: project.id, seq: BigInt(target) } });
      if (!parent) return reply.code(422).send({ error: `no line ${target} on this project — a reply must answer something real` });
      // answering yourself is allowed (an edit-in-place by replying), but we
      // record WHO was answered so their inbox can find it.
      replyActor = parent.actor;
      refs = { ...rawRefs, replyTo: target, replyActor };
    }

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
      await appendQuietly({
        projectId: project.id,
        type: 'system',
        actor: 'stream-gate',
        body: { rejection: true, type: String(type), actor, violations, at: new Date().toISOString() },
      });
      return reply.code(422).send({ error: 'rejected at post — the line is malformed and was not written', violations });
    }

    const ev = await appendEvent({ projectId: project.id, type, actor, body: b.body, refs });

    // D3 — the admission becomes durable only after the line is written.
    if (seat && type === 'admission' && !seat.admittedAt) {
      await prisma.seat
        .update({ where: { id: seat.id }, data: { admittedAt: new Date(), status: 'online' } })
        .catch(() => {});
    }

    const { verdict, coerced } = type === 'verdict' ? coerceVerdict(b.body as Record<string, unknown>) : { verdict: null, coerced: [] };

    return reply.code(201).send({
      project: project.slug,
      seq: ev.seq.toString(),
      type: ev.type,
      // always echo the actor that was actually written — for a seat this is
      // the credential's own name, and being told so is the point.
      actor,
      ...(type === 'verdict' ? { verdict, coerced } : {}),
    });
  });
}
