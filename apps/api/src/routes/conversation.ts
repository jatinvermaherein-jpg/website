// CONVERSATION — the part of a crew that was missing.
//
// The bus was a broadcast log. An agent could post, but it had no idea what
// had been said TO it without downloading the entire stream and filtering by
// hand — which is what docs/AGENT-PROTOCOL.md told it to do ("filter the bus by
// body.to === your seat to work your inbox"). At four agents that is noise; at
// ten it is unusable.
//
// A conversation needs three things a log does not have:
//
//   1. AN INBOX     — what was addressed to me, since I last looked.
//   2. THREADS      — a reply knows what it is replying to.
//   3. A HANDOVER   — an agent that stops says what it finished, what it did
//                     not, and what the next one should pick up. The Handover
//                     table has existed in the schema since day one with zero
//                     routes; this is it, wired.
//
// Rule that keeps the two surfaces distinct:
//   the STREAM is what happened. the INBOX is what was said to you.
// A broadcast belongs to the stream, not to ten inboxes.
//
//   GET  /api/projects/:slug/inbox[?since=<seq>]   addressed to me
//   GET  /api/projects/:slug/thread/:seq           the conversation around a line
//   POST /api/projects/:slug/handover              I am stopping — here is the state
//   GET  /api/projects/:slug/handover              recent handovers, newest first
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { seatFromBearer, touchSeat } from '../lib/seatauth.js';
import { appendEvent } from '../lib/append.js';

type Who = { projectId: string; slug: string; actor: string; isSeat: boolean };

async function who(req: Parameters<typeof seatFromBearer>[0] & { params: unknown }, reply: {
  code: (n: number) => { send: (b: unknown) => unknown };
}): Promise<Who | null> {
  const slug = (req.params as { slug: string }).slug;
  const seat = await seatFromBearer(req);
  if (seat) {
    const p = await prisma.project.findUnique({ where: { slug } });
    if (!p) return reply.code(404).send({ error: 'no such project' }) as never;
    const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: p.id } } });
    if (!joined) return reply.code(404).send({ error: 'no such project for this seat' }) as never;
    touchSeat(seat.id);
    return { projectId: p.id, slug: p.slug, actor: seat.name, isSeat: true };
  }
  const user = await requireUser(req as never, reply as never);
  if (!user) return null;
  const m = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!m) return reply.code(404).send({ error: 'no org' }) as never;
  const p = await prisma.project.findFirst({ where: { slug, orgId: m.orgId } });
  if (!p) return reply.code(404).send({ error: 'no such project' }) as never;
  return { projectId: p.id, slug: p.slug, actor: user.username, isSeat: false };
}

const line = (e: { seq: bigint; type: string; actor: string; at: Date; body: unknown; refs: unknown }) => {
  const b = (e.body ?? {}) as Record<string, unknown>;
  const r = (e.refs ?? {}) as Record<string, unknown>;
  return {
    seq: e.seq.toString(),
    type: e.type,
    actor: e.actor,
    ts: e.at.toISOString(),
    to: typeof b.to === 'string' ? b.to : undefined,
    replyTo: typeof r.replyTo === 'string' ? r.replyTo : undefined,
    text: typeof b.text === 'string' ? b.text : undefined,
    body: e.body,
  };
};

export async function conversationRoutes(app: FastifyInstance) {
  // ── the inbox ──────────────────────────────────────────────────────────
  // Addressed to me by name, OR a reply to one of my lines.
  // `to: "all"` / `to: "team"` are broadcasts — they belong to the stream.
  app.get('/:slug/inbox', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;

    const q = req.query as { since?: string; limit?: string };
    let since = 0n;
    if (q.since !== undefined) {
      if (!/^\d+$/.test(q.since)) return reply.code(422).send({ error: 'since must be a non-negative integer' });
      since = BigInt(q.since);
    }
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));

    const [addressed, repliesToMe] = await Promise.all([
      prisma.event.findMany({
        where: { projectId: me.projectId, seq: { gt: since }, body: { path: ['to'], equals: me.actor } },
        orderBy: { seq: 'asc' },
        take: limit,
      }),
      // a reply to something I wrote is a message to me
      prisma.event.findMany({
        where: { projectId: me.projectId, seq: { gt: since }, refs: { path: ['replyActor'], equals: me.actor } },
        orderBy: { seq: 'asc' },
        take: limit,
      }),
    ]);

    const seen = new Set<string>();
    const merged = [...addressed, ...repliesToMe]
      .filter((e) => (seen.has(e.seq.toString()) ? false : seen.add(e.seq.toString())))
      .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
      .slice(0, limit);

    const head = await prisma.event.findFirst({ where: { projectId: me.projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });

    return {
      project: me.slug,
      me: me.actor,
      unread: merged.length,
      // the seq to pass as `since` next time — the head, so nothing is re-read
      head: head?.seq?.toString() ?? '0',
      messages: merged.map(line),
      note: merged.length === 0 ? 'nothing addressed to you since that point' : undefined,
    };
  });

  // ── a thread ───────────────────────────────────────────────────────────
  // Walks UP to the root by replyTo, then DOWN to every descendant. Answers
  // "what was this about", which is the question a log cannot answer.
  app.get('/:slug/thread/:seq', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    const raw = (req.params as { seq: string }).seq;
    if (!/^\d+$/.test(raw)) return reply.code(422).send({ error: 'seq must be an integer' });
    const start = BigInt(raw);

    const anchor = await prisma.event.findFirst({ where: { projectId: me.projectId, seq: start } });
    if (!anchor) return reply.code(404).send({ error: `no line ${raw} on this project` });

    const all = await prisma.event.findMany({
      where: { projectId: me.projectId, seq: { lte: start } },
      orderBy: { seq: 'desc' },
      take: 500,
    });
    const bySeq = new Map(all.map((e) => [e.seq.toString(), e]));

    // walk up
    const chain: string[] = [];
    let cur: string | undefined = raw;
    for (let i = 0; i < 200 && cur; i++) {
      chain.push(cur);
      const e = bySeq.get(cur);
      const parent = e ? ((e.refs ?? {}) as Record<string, unknown>).replyTo : undefined;
      cur = typeof parent === 'string' ? parent : undefined;
    }
    const rootSeq = chain[chain.length - 1]!;

    // walk down: everything reachable from the root
    const toWalk = [rootSeq];
    const collected = new Set<string>([rootSeq]);
    while (toWalk.length) {
      const parent = toWalk.pop()!;
      const kids = await prisma.event.findMany({
        where: { projectId: me.projectId, refs: { path: ['replyTo'], equals: parent } },
        select: { seq: true },
      });
      for (const k of kids) {
        const s = k.seq.toString();
        if (!collected.has(s)) {
          collected.add(s);
          toWalk.push(s);
        }
      }
    }

    const seqs = [...collected];
    const rows = await prisma.event.findMany({
      where: { projectId: me.projectId, seq: { in: seqs.map((x) => BigInt(x)) } },
      orderBy: { seq: 'asc' },
    });

    return {
      project: me.slug,
      root: rootSeq,
      focused: raw,
      count: rows.length,
      lines: rows.map(line),
    };
  });

  // ── a handover ─────────────────────────────────────────────────────────
  // An agent stops. It says what it finished, what it did not, and what the
  // next agent should pick up — and the line lands on the bus so nobody has
  // to read a log file to discover it.
  app.post('/:slug/handover', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;

    const parsed = z
      .object({
        finished: z.string().min(1).max(4000),
        unfinished: z.string().min(1).max(4000),
        next: z.string().min(1).max(4000),
        refs: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid handover' });

    const { finished, unfinished, next, refs } = parsed.data;
    const text = `HANDOVER from ${me.actor}\nfinished: ${finished}\nunfinished: ${unfinished}\nnext: ${next}`;

    const seatRow = me.isSeat ? await prisma.seat.findFirst({ where: { name: me.actor, orgId: (await prisma.project.findUniqueOrThrow({ where: { id: me.projectId } })).orgId } }) : null;

    // store it in the table that has waited since day one
    const row = await prisma.handover.create({
      data: {
        projectId: me.projectId,
        seatId: seatRow?.id ?? me.actor,
        body: JSON.stringify({ finished, unfinished, next, refs, actor: me.actor }),
      },
    });

    // and put it on the bus, through the one authority like every other line
    const ev = await appendEvent({
      projectId: me.projectId,
      type: 'message',
      actor: me.actor,
      body: { text, to: 'all', handover: true, finished, unfinished, next },
      refs: { ...(refs ?? {}), handoverId: row.id },
    });

    return reply.code(201).send({ handoverId: row.id, seq: ev.seq.toString(), at: row.ts.toISOString() });
  });

  app.get('/:slug/handover', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    const rows = await prisma.handover.findMany({ where: { projectId: me.projectId }, orderBy: { ts: 'desc' }, take: 20 });
    return {
      project: me.slug,
      handovers: rows.map((h) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(h.body) as Record<string, unknown>;
        } catch {
          parsed = { raw: h.body };
        }
        return { id: h.id, seatId: h.seatId, at: h.ts.toISOString(), ...parsed };
      }),
    };
  });
}
