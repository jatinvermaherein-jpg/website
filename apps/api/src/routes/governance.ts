// GOVERNANCE — the two tables that make a law book a system.
//
// `Waiver` and `Breach` have been in this schema since day one with zero
// routes. A ruleset with no way to record an exception and no way to record
// a violation is a document, not a government. This is the missing half.
//
//   WAIVER  — a deliberate, scoped, EXPIRING exception. Only the operator
//             grants one, it names the rule, it says why, and it cannot
//             outlive its date. A waiver is a decision on the record, not a
//             silence.
//   BREACH  — a recorded violation, written by the seat that found it, with
//             the correction it proposes. Discovering a breach is not an
//             accusation; hiding one is.
//
// Resolution law (read side, derived — never stored):
//   a resolved `fail` with a live waiver covering its rule reads as `waived`.
//   an expired waiver reads as nothing at all. It stops existing.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser, requireOperator } from '../lib/auth.js';
import { seatFromBearer, touchSeat } from '../lib/seatauth.js';
import { appendQuietly } from '../lib/append.js';

const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,40}$/;

type Who =
  | { kind: 'seat'; projectId: string; slug: string; actor: string; role: string; admitted: boolean }
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
    return { kind: 'seat', projectId: project.id, slug: project.slug, actor: seat.name, role: seat.role, admitted: seat.admittedAt !== null };
  }
  const user = await requireUser(req, reply);
  if (!user) return null;
  const m = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!m) return p.code(404).send({ error: 'no org' }) as never;
  const project = await prisma.project.findFirst({ where: { slug, orgId: m.orgId } });
  if (!project) return p.code(404).send({ error: 'no such project' }) as never;
  return { kind: 'human', projectId: project.id, slug: project.slug, actor: user.username, isOperator: user.isOperator };
}

const live = (w: { expiresAt: Date }) => w.expiresAt.getTime() > Date.now();

export async function governanceRoutes(app: FastifyInstance) {
  // ── waivers ────────────────────────────────────────────────────────────
  app.get('/:slug/waivers', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    const rows = await prisma.waiver.findMany({ where: { projectId: me.projectId }, orderBy: { ts: 'desc' }, take: 100 });
    return {
      project: me.slug,
      waivers: rows.map((w) => ({
        id: w.id,
        ruleId: w.ruleId,
        reason: w.reason,
        scope: w.scope,
        actor: w.actor,
        grantedAt: w.ts.toISOString(),
        expiresAt: w.expiresAt.toISOString(),
        live: live(w),
      })),
      note: 'a waiver is an exception that expires. an expired waiver stops existing — it is listed here only so the decision stays auditable.',
    };
  });

  app.post('/:slug/waivers', async (req, reply) => {
    // granting an exception is an operator act. A crew cannot waive its own law.
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind === 'seat' || !me.isOperator) {
      return reply.code(403).send({
        error: 'only the operator grants a waiver — a crew that can waive its own rules does not have rules',
        rule: 'separation of powers',
      });
    }
    const parsed = z
      .object({
        ruleId: z.string().regex(RULE_RE, 'ruleId must look like J-09 or 1.9'),
        reason: z.string().min(10).max(2000),
        scope: z.string().min(1).max(200),
        days: z.number().int().min(1).max(365).default(7),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid waiver' });

    const expiresAt = new Date(Date.now() + parsed.data.days * 86_400_000);
    const w = await prisma.waiver.create({
      data: { projectId: me.projectId, ruleId: parsed.data.ruleId, reason: parsed.data.reason, scope: parsed.data.scope, expiresAt, actor: me.actor },
    });
    await appendQuietly({
      projectId: me.projectId,
      type: 'waiver',
      actor: me.actor,
      body: { waiverId: w.id, ruleId: w.ruleId, scope: w.scope, reason: w.reason, expiresAt: w.expiresAt.toISOString() },
    });
    return reply.code(201).send({ id: w.id, ruleId: w.ruleId, expiresAt: w.expiresAt.toISOString(), live: true });
  });

  // ── breaches ───────────────────────────────────────────────────────────
  app.get('/:slug/breaches', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    const rows = await prisma.breach.findMany({ where: { projectId: me.projectId }, orderBy: { ts: 'desc' }, take: 100 });
    return {
      project: me.slug,
      breaches: rows.map((b) => ({
        id: b.id,
        ruleId: b.ruleId,
        artifactRef: b.artifactRef,
        discoveringSeat: b.discoveringSeat,
        correction: b.correction,
        at: b.ts.toISOString(),
      })),
      note: 'a breach is a record, not an accusation. the seat that found it is named on it.',
    };
  });

  app.post('/:slug/breaches', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;
    if (me.kind === 'seat' && !me.admitted) {
      return reply.code(409).send({ error: `seat "${me.actor}" has not admitted itself`, rule: 'D3' });
    }
    const parsed = z
      .object({
        ruleId: z.string().regex(RULE_RE, 'ruleId must look like J-09 or 1.9'),
        artifactRef: z.string().min(1).max(500),
        correction: z.string().min(1).max(2000),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid breach' });

    const b = await prisma.breach.create({
      data: {
        projectId: me.projectId,
        ruleId: parsed.data.ruleId,
        artifactRef: parsed.data.artifactRef,
        discoveringSeat: me.actor,
        correction: parsed.data.correction,
      },
    });
    await appendQuietly({
      projectId: me.projectId,
      type: 'breach',
      actor: me.actor,
      body: { breachId: b.id, ruleId: b.ruleId, artifactRef: b.artifactRef, correction: b.correction, discoveringSeat: me.actor },
    });
    return reply.code(201).send({ id: b.id, ruleId: b.ruleId, at: b.ts.toISOString() });
  });

  // ── the resolved ledger, with waivers applied ──────────────────────────
  // One page that answers: what is true, at what fidelity, who decided it,
  // and which exceptions are currently in force.
  // (crosscheck.ts owns /rows — the raw append-only register. This is the
  // resolved view, which is a different question and deserves its own name.)
  app.get('/:slug/ledger', async (req, reply) => {
    const me = await who(req as never, reply as never);
    if (!me) return;

    const [rows, verdicts, waivers] = await Promise.all([
      prisma.ledgerRow.findMany({ where: { projectId: me.projectId }, orderBy: [{ rowId: 'asc' }, { ts: 'desc' }] }),
      prisma.verdict.findMany({ where: { projectId: me.projectId }, orderBy: { ts: 'asc' } }),
      prisma.waiver.findMany({ where: { projectId: me.projectId } }),
    ]);

    const latestRow = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latestRow.has(r.rowId)) latestRow.set(r.rowId, r);
    const liveWaivers = waivers.filter(live);

    // A verdict can name a row nobody registered — every task that is
    // witnessed gets one (`T-…` when no row was attached). Those were
    // invisible here: work was decided, and the ledger said nothing. A ledger
    // that hides decisions is worse than no ledger, so unregistered rows are
    // folded in and marked as unregistered rather than dropped.
    const unregistered = [...new Set(verdicts.map((v) => v.rowId))].filter((rowId) => !latestRow.has(rowId));

    const resolved = [
      ...[...latestRow.values()].map((r) => ({
        rowId: r.rowId,
        requirement: r.requirement,
        environment: r.environment,
        baseStatus: r.status,
        registered: true,
      })),
      ...unregistered.map((rowId) => {
        const mine = verdicts.filter((v) => v.rowId === rowId);
        const last = mine[mine.length - 1];
        let req = '(unregistered row)';
        try {
          const ev = (last?.evidence ?? null) as { reason?: string }[] | null;
          if (Array.isArray(ev) && ev[0]?.reason) req = ev[0].reason;
        } catch {
          /* evidence is free-form; a missing reason is not an error */
        }
        return {
          rowId,
          requirement: req,
          environment: (last?.environment as string | undefined) ?? null,
          baseStatus: (last?.verdict as string | undefined) ?? 'unproven',
          registered: false,
        };
      }),
    ].map((r) => {
      const vs = verdicts.filter((v) => v.rowId === r.rowId);
      const witnessed = vs.filter((v) => !v.attestedNotWitnessed && v.falsification !== null);
      const poisoned = witnessed.some((v) => {
        const c = v.instrumentControl as { failedAsExpected?: boolean } | null;
        return c && c.failedAsExpected === false;
      });
      const latest = witnessed[witnessed.length - 1];

      let status: string = r.baseStatus;
      let by: string | null = null;
      if (witnessed.length) {
        status = poisoned ? 'unproven' : latest!.verdict;
        by = latest!.seat;
      }
      const waiver = status === 'fail' ? liveWaivers.find((w) => w.ruleId === r.rowId) : undefined;
      if (waiver) status = 'waived';

      return {
        rowId: r.rowId,
        requirement: r.requirement,
        environment: r.environment,
        status,
        decidedBy: by,
        verdicts: vs.length,
        witnessed: witnessed.length,
        registered: r.registered,
        waiver: waiver ? { ruleId: waiver.ruleId, reason: waiver.reason, expiresAt: waiver.expiresAt.toISOString() } : null,
      };
    });

    return {
      project: me.slug,
      counts: resolved.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}),
      rows: resolved.sort((a, b) => a.rowId.localeCompare(b.rowId)),
      liveWaivers: liveWaivers.map((w) => ({ ruleId: w.ruleId, expiresAt: w.expiresAt.toISOString() })),
      breaches: await prisma.breach.count({ where: { projectId: me.projectId } }),
    };
  });
}
