// THE WORK LOOP — conversation becomes work, and work becomes decided.
//
// Before this file a crew could talk and could run a process, and there was
// nothing in between: no way to put a unit of work on the board, take it,
// hand it back, and have somebody else rule on it. Task rows only ever
// appeared as a side-effect of starting a run.
//
// The loop, and the law at each step:
//
//   create  → operator, or an admitted lead/scribe. A task names its
//             acceptance and the fidelity level it must be proven at.
//   claim   → an admitted seat takes it. One owner. First claim wins.
//   submit  → THE OWNER ONLY. Work + artifacts + a claim. Status → review.
//   witness → a DIFFERENT seat, role auditor or lead. Separation of duties
//             is enforced here, not hoped for: the seat that did the work
//             can never be the seat that signs it off.
//
// A witness must supply a falsification attempt and an instrument control,
// because a verdict without them is demoted to `unproven` by the envelope
// law — and an `unproven` witness does not close a task.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { seatFromBearer, touchSeat } from '../lib/seatauth.js';
import { coerceVerdict } from '../lib/envelope.js';
import { appendEvent, appendQuietly } from '../lib/append.js';
import { ENVIRONMENTS } from '../lib/envelope.js';

const ROW_ID_RE = /^J-\d{1,4}$/;
// ONLY an auditor. A lead runs the crew; letting the lead also rule on the
// work puts the person who directed it in charge of judging it. The rule is
// "everything is audited by an auditor" — not "by someone senior enough".
const WITNESS_ROLES = new Set(['auditor']);
const CREATOR_ROLES = new Set(['lead', 'scribe', 'auditor']);

type Who =
  | { kind: 'seat'; projectId: string; slug: string; actor: string; role: string; seatId: string; admitted: boolean }
  | { kind: 'human'; projectId: string; slug: string; actor: string; isOperator: boolean };

async function who(req: never, reply: never): Promise<Who | null> {
  const r = req as unknown as { params: { slug: string } };
  const p = reply as unknown as { code: (n: number) => { send: (b: unknown) => unknown } };
  const slug = r.params.slug;

  const seat = await seatFromBearer(req);
  if (seat) {
    const project = await prisma.project.findUnique({ where: { slug } });
    if (!project) return p.code(404).send({ error: 'no such project' }) as never;
    const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: project.id } } });
    if (!joined) return p.code(404).send({ error: 'no such project for this seat' }) as never;
    touchSeat(seat.id);
    return { kind: 'seat', projectId: project.id, slug: project.slug, actor: seat.name, role: seat.role, seatId: seat.id, admitted: seat.admittedAt !== null };
  }
  const user = await requireUser(req, reply);
  if (!user) return null;
  const m = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!m) return p.code(404).send({ error: 'no org' }) as never;
  const project = await prisma.project.findFirst({ where: { slug, orgId: m.orgId } });
  if (!project) return p.code(404).send({ error: 'no such project' }) as never;
  return { kind: 'human', projectId: project.id, slug: project.slug, actor: user.username, isOperator: user.isOperator };
}

const taskView = (t: {
  id: string; title: string; status: string; acceptanceVerb: string | null; environment: string;
  ownerId: string | null; witnessId: string | null; rowId: string | null;
  createdAt: Date; claimedAt: Date | null; submittedAt: Date | null;
}) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  environment: t.environment,
  acceptance: t.acceptanceVerb,
  rowId: t.rowId,
  ownerId: t.ownerId,
  witnessId: t.witnessId,
  createdAt: t.createdAt.toISOString(),
  claimedAt: t.claimedAt ? t.claimedAt.toISOString() : null,
  submittedAt: t.submittedAt ? t.submittedAt.toISOString() : null,
});

export async function taskRoutes(app: FastifyInstance) {
  // ── the board ──────────────────────────────────────────────────────────
  app.get('/:slug/tasks', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    const q = req.query as { status?: string };
    const tasks = await prisma.task.findMany({
      where: { projectId: me.projectId, ...(q.status ? { status: q.status } : {}), runId: null },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });
    const seats = await prisma.seat.findMany({ where: { id: { in: tasks.flatMap((t) => [t.ownerId, t.witnessId].filter(Boolean) as string[]) } }, select: { id: true, name: true, role: true } });
    const nameOf = new Map(seats.map((s) => [s.id, `${s.name} (${s.role})`]));
    return {
      project: me.slug,
      counts: tasks.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}),
      tasks: tasks.map((t) => ({ ...taskView(t), owner: t.ownerId ? nameOf.get(t.ownerId) ?? null : null, witness: t.witnessId ? nameOf.get(t.witnessId) ?? null : null })),
    };
  });

  // ── create ─────────────────────────────────────────────────────────────
  app.post('/:slug/tasks', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind === 'seat' && (!me.admitted || !CREATOR_ROLES.has(me.role))) {
      return reply.code(403).send({
        error: `a ${me.role} cannot put work on the board — a task is a commitment, and it needs an admitted lead, scribe or auditor`,
        rule: 'D3/D7: admission before authority, and role decides which authority',
      });
    }
    const parsed = z
      .object({
        title: z.string().min(3).max(200),
        acceptance: z.string().max(2000).optional(),
        environment: z.enum(ENVIRONMENTS).default('local-stack'),
        rowId: z.string().regex(ROW_ID_RE).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid task' });

    const task = await prisma.task.create({
      data: {
        projectId: me.projectId,
        title: parsed.data.title,
        acceptanceVerb: parsed.data.acceptance ?? null,
        environment: parsed.data.environment,
        rowId: parsed.data.rowId ?? null,
        status: 'backlog',
      },
    });
    await appendQuietly({
      projectId: me.projectId,
      type: 'task',
      actor: me.actor,
      body: { taskId: task.id, title: task.title, status: 'created', environment: task.environment, acceptance: task.acceptanceVerb },
    });
    return reply.code(201).send(taskView(task));
  });

  // ── claim: one owner, first claim wins ─────────────────────────────────
  app.post('/:slug/tasks/:id/claim', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind !== 'seat') return reply.code(403).send({ error: 'work is claimed by a seat, not a human — open a seat to take this' });
    if (!me.admitted) {
      return reply.code(409).send({ error: `seat "${me.actor}" has not admitted itself`, rule: 'D3: joining grants attention, not authority' });
    }
    const { id } = req.params as { slug: string; id: string };
    const task = await prisma.task.findFirst({ where: { id, projectId: me.projectId } });
    if (!task) return reply.code(404).send({ error: 'no such task' });

    // atomic: only an unowned, open task can be claimed. Two seats racing
    // means exactly one gets it — count 0 says somebody else was first.
    const won = await prisma.task.updateMany({
      where: { id, projectId: me.projectId, ownerId: null, status: { in: ['backlog', 'in_progress'] } },
      data: { ownerId: me.seatId, status: 'in_progress', claimedAt: new Date() },
    });
    if (won.count === 0) {
      const now = await prisma.task.findUniqueOrThrow({ where: { id } });
      return reply.code(409).send({
        error: now.ownerId ? 'that task already has an owner — one task, one owner' : `a task in "${now.status}" cannot be claimed`,
        ownerId: now.ownerId,
        status: now.status,
      });
    }
    await appendQuietly({ projectId: me.projectId, type: 'task', actor: me.actor, body: { taskId: id, title: task.title, status: 'claimed' } });
    return { taskId: id, status: 'in_progress', owner: me.actor };
  });

  // ── submit: the owner hands back work ──────────────────────────────────
  app.post('/:slug/tasks/:id/submit', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind !== 'seat') return reply.code(403).send({ error: 'a submission comes from the seat that did the work' });
    const { id } = req.params as { slug: string; id: string };
    const task = await prisma.task.findFirst({ where: { id, projectId: me.projectId } });
    if (!task) return reply.code(404).send({ error: 'no such task' });
    if (task.ownerId !== me.seatId) {
      return reply.code(403).send({ error: 'only the owner submits this task', ownerId: task.ownerId, you: me.seatId });
    }
    const parsed = z
      .object({
        summary: z.string().min(1).max(4000),
        artifacts: z
          .array(z.object({ commit: z.string().min(1).max(80), path: z.string().min(1).max(400), contentHash: z.string().min(8).max(200) }))
          .max(50)
          .default([]),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid submission' });

    // artifacts are recorded, not merely mentioned — Artifact was a dead table
    for (const a of parsed.data.artifacts) {
      await prisma.artifact
        .create({ data: { projectId: me.projectId, commit: a.commit, path: a.path, contentHash: a.contentHash } })
        .catch(() => {
          /* already recorded for this commit — the unique constraint is the dedupe */
        });
    }

    const moved = await prisma.task.updateMany({
      where: { id, ownerId: me.seatId, status: 'in_progress' },
      data: { status: 'review', submittedAt: new Date() },
    });
    if (moved.count === 0) return reply.code(409).send({ error: 'that task is not in a submittable state' });

    await appendQuietly({
      projectId: me.projectId,
      type: 'task',
      actor: me.actor,
      body: { taskId: id, title: task.title, status: 'submitted', summary: parsed.data.summary, artifacts: parsed.data.artifacts.length },
    });
    return { taskId: id, status: 'review', awaitingWitness: true };
  });

  // ── witness: somebody else rules on it ─────────────────────────────────
  app.post('/:slug/tasks/:id/witness', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind !== 'seat') return reply.code(403).send({ error: 'a task is witnessed by a seat' });
    if (!me.admitted) return reply.code(409).send({ error: `seat "${me.actor}" has not admitted itself`, rule: 'D3' });
    const { id } = req.params as { slug: string; id: string };
    const task = await prisma.task.findFirst({ where: { id, projectId: me.projectId } });
    if (!task) return reply.code(404).send({ error: 'no such task' });

    // SEPARATION OF DUTIES first — it is the more specific refusal. Telling a
    // builder "a builder does not witness" hides the real problem when the
    // task in question is its own.
    if (task.ownerId && task.ownerId === me.seatId) {
      return reply.code(403).send({
        error: 'you cannot witness your own work — that is not a second opinion, it is the same opinion twice',
        rule: 'separation of duties',
      });
    }
    if (!WITNESS_ROLES.has(me.role)) {
      return reply.code(403).send({
        error: `a ${me.role} does not witness — the gate that decides must never be the gate that built`,
        rule: 'D7',
      });
    }
    if (task.status !== 'review') return reply.code(409).send({ error: `a task in "${task.status}" is not awaiting a witness` });

    const parsed = z
      .object({
        verdict: z.enum(['pass', 'fail']),
        reason: z.string().min(1).max(4000),
        falsification: z.object({ command: z.string(), output_digest: z.string() }).optional(),
        instrumentControl: z.object({ command: z.string(), output_digest: z.string(), expected_failure: z.string() }).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid witness' });

    // A verdict is not a decision until the law has looked at it. The law
    // (coerceVerdict) needs BOTH a falsification attempt AND an instrument
    // control to let a pass stand. This route used to guess with half the
    // test — a pass with falsification but no control closed the task `done`
    // while the stream recorded `unproven`. The task and the ledger disagreed,
    // which is the one thing the ledger exists to prevent.
    //
    // So: build the body, run the real law on it, and derive the task status
    // from the verdict that will actually be written. Never from a local guess.
    const rowId = task.rowId ?? `T-${id.slice(-6).toUpperCase()}`;
    const verdictBody = {
      rowId,
      seat: me.actor,
      direction: 'falsify' as const,
      environment: task.environment,
      verdict: parsed.data.verdict,
      evidence: [{ kind: 'repo', taskId: id, reason: parsed.data.reason }],
      ...(parsed.data.falsification ? { falsification: parsed.data.falsification } : {}),
      ...(parsed.data.instrumentControl ? { instrumentControl: parsed.data.instrumentControl } : {}),
      attestedNotWitnessed: false,
    };

    const expected = coerceVerdict(verdictBody as unknown as Record<string, unknown>);
    const statusFor = (v: string): string => (v === 'fail' ? 'blocked' : v === 'pass' ? 'done' : 'review');

    // the verdict goes on the bus through the normal path, so the demotion
    // law applies to it exactly as it would to any other verdict
    const ev = await appendEvent({
      projectId: me.projectId,
      type: 'verdict',
      actor: me.actor,
      body: verdictBody,
    });

    // the stream is the authority; the task follows it
    const decided = ((ev.body as { verdict?: string }) ?? {}).verdict ?? 'unproven';
    if (decided !== expected.verdict) {
      // the two laws have diverged — say so loudly rather than write a
      // status the ledger will contradict
      req.log.error({ taskId: id, decided, expected: expected.verdict }, 'verdict law divergence in witness');
    }
    const nextStatus = statusFor(decided);

    await prisma.task.update({
      where: { id },
      data: { witnessId: me.seatId, status: nextStatus },
    });

    return {
      taskId: id,
      witnessedBy: me.actor,
      verdict: decided,
      taskStatus: nextStatus,
      demotedFor: decided === 'unproven' ? expected.coerced : undefined,
      note:
        decided === 'unproven'
          ? `recorded unproven (${expected.coerced.join(', ') || 'no proof'}) — the task stays in review`
          : undefined,
    };
  });
}
