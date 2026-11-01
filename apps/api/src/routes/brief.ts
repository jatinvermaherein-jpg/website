// THE BRIEF — what a seat gets when it joins.
//
// The question this answers: "does an agent have the same access I do?"
// It gets the project, its own identity and standing, the rules, the index
// of every document, the names of every env var (never the values), the
// whole team with presence, where to resume on the bus, and what is running.
//
// If it is not in here, the agent does not need it to start. If it is in
// here, the agent should not need to ask a human for it.
//
//   GET /api/projects/:slug/brief        (seat key OR web session)
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { seatFromBearer, touchSeat, SEAT_ONLINE_MS } from '../lib/seatauth.js';

export async function briefRoutes(app: FastifyInstance) {
  app.get('/:slug/brief', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const seat = await seatFromBearer(req);

    let projectId: string;
    let actor: string;
    let me: Record<string, unknown>;

    if (seat) {
      const p = await prisma.project.findUnique({ where: { slug } });
      if (!p) return reply.code(404).send({ error: 'no such project' });
      const joined = await prisma.seatProject.findUnique({
        where: { seatId_projectId: { seatId: seat.id, projectId: p.id } },
      });
      if (!joined) return reply.code(404).send({ error: 'no such project for this seat' });
      projectId = p.id;
      actor = seat.name;
      touchSeat(seat.id);
      const fresh = (await prisma.seat.findUnique({ where: { id: seat.id } })) ?? seat;
      me = {
        name: fresh.name,
        role: fresh.role,
        status: fresh.status,
        admitted: fresh.admittedAt !== null,
        admittedAt: fresh.admittedAt ? fresh.admittedAt.toISOString() : null,
        joinedAt: joined.joinedAt.toISOString(),
        // the exact next thing this seat should do, in order
        nextStep:
          fresh.admittedAt === null
            ? 'POST an admission line before any verdict or task — {takes, stale, doesNotUnderstand}'
            : 'read the bus, take work, file verdicts with a falsification attempt',
      };
    } else {
      const user = await requireUser(req, reply);
      if (!user) return;
      const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
      if (!membership) return reply.code(404).send({ error: 'no org' });
      const p = await prisma.project.findFirst({ where: { slug, orgId: membership.orgId } });
      if (!p) return reply.code(404).send({ error: 'no such project' });
      projectId = p.id;
      actor = user.username;
      me = { name: user.username, role: 'operator', status: 'human', admitted: true, admittedAt: null };
    }

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

    const [docs, env, team, tasks, lastEvent, inbox, handovers] = await Promise.all([
      prisma.projectDoc.findMany({ where: { projectId, archivedAt: null }, orderBy: [{ slug: 'asc' }, { version: 'desc' }] }),
      prisma.projectEnv.findMany({ where: { projectId }, orderBy: { name: 'asc' } }),
      prisma.seat.findMany({ where: { status: { not: 'archived' }, projects: { some: { projectId } } }, orderBy: { createdAt: 'asc' } }),
      prisma.task.findMany({ where: { projectId, status: 'in_progress' }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.event.findFirst({ where: { scopeId: projectId }, orderBy: { seq: 'desc' }, select: { seq: true } }),
      // what is waiting for THIS seat — the same rule as /inbox: addressed to
      // me by name, OR a reply to something I wrote.
      Promise.all([
        prisma.event.findMany({ where: { projectId, body: { path: ['to'], equals: actor } }, select: { seq: true } }),
        prisma.event.findMany({ where: { projectId, refs: { path: ['replyActor'], equals: actor } }, select: { seq: true } }),
      ]).then(([a, b]) => new Set([...a, ...b].map((x) => x.seq.toString())).size),
      prisma.handover.findMany({ where: { projectId }, orderBy: { ts: 'desc' }, take: 3 }),
    ]);

    const latest = new Map<string, (typeof docs)[number]>();
    for (const d of docs) if (!latest.has(d.slug)) latest.set(d.slug, d);

    const rules = latest.get('rules');

    return {
      project: {
        slug: project.slug,
        name: project.name,
        status: project.status,
        activeRulesetVersion: project.activeRulesetVersion,
      },
      me,
      // where to start reading. Exact, so nobody re-reads 4,000 lines.
      bus: {
        stream: `/api/projects/${project.slug}/stream`,
        head: lastEvent?.seq?.toString() ?? '0',
        pollHint: 'poll with afterSeq=<nextCursor> every ~2s; every read is your heartbeat',
      },
      rules: rules
        ? {
            slug: rules.slug,
            version: rules.version,
            sha256: rules.contentHash,
            bytes: rules.bytes,
            fetch: `/api/projects/${project.slug}/docs/rules`,
          }
        : null,
      docs: [...latest.values()].map((d) => ({
        slug: d.slug,
        kind: d.kind,
        title: d.title,
        version: d.version,
        bytes: d.bytes,
        sha256: d.contentHash,
        fetch: `/api/projects/${project.slug}/docs/${d.slug}`,
      })),
      // names and masks only — a brief must never carry a secret value
      env: env.map((e) => ({ name: e.name, mask: e.keyMask })),
      team: team.map((s) => ({
        name: s.name,
        role: s.role,
        status: s.status,
        online: s.lastHeartbeat !== null && Date.now() - s.lastHeartbeat.getTime() < SEAT_ONLINE_MS,
        admitted: s.admittedAt !== null,
      })),
      running: tasks.map((t) => ({ taskId: t.id, runId: t.runId, title: t.title })),
      // the conversation, at a glance: is anything waiting for you, and what
      // did the last agent to stop say the next one should do
      inbox: { waiting: inbox, fetch: `/api/projects/${project.slug}/inbox` },
      lastHandovers: handovers.map((h) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(h.body) as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        return { at: h.ts.toISOString(), actor: parsed.actor, finished: parsed.finished, unfinished: parsed.unfinished, next: parsed.next };
      }),
      readBy: actor,
    };
  });
}
