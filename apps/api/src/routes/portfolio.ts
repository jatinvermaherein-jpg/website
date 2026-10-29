// CREW — the portfolio (Phase 11).
//
//   Every project, its rows as the cross-check RESOLVES them (derived on
//   read — law 2.1), and the NEXT HUMAN DECISION each project is waiting on.
//   Decisions are derived, never stored: a fail wants re-plan/waive/carry,
//   an un-witnessed claim wants an auditor, a blocked row wants unblock,
//   an all-green project wants the ship decision. A stranger can read this
//   page and know exactly what to do next.
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { resolveRow } from './crosscheck.js';

interface ResolvedRow {
  rowId: string;
  requirement: string | null;
  environment: string;
  ledgerStatus: string;
  resolved: string;
  witnessedBy: string | null;
  builderClaim: string | null;
  consequence: string | null;
}

// the next human decision for a project — deterministic, in this order of
// urgency: witness a claim, unblock, replan a fail, prove an unproven,
// start an untouched row; ship when nothing is open.
function openDecisions(rows: ResolvedRow[]): { kind: string; rowId?: string; prompt: string; options: string[] }[] {
  const decisions: { kind: string; rowId?: string; prompt: string; options: string[] }[] = [];
  for (const r of rows) {
    if (r.resolved === 'pass' || r.resolved === 'carried') continue;
    if (r.builderClaim) {
      decisions.push({
        kind: 'witness',
        rowId: r.rowId,
        prompt: `${r.rowId} is claimed (${r.builderClaim}) but no one has run the falsification — schedule an auditor, or reject the claim`,
        options: ['witness', 'reject'],
      });
    } else if (r.resolved === 'blocked' || r.ledgerStatus === 'blocked') {
      decisions.push({
        kind: 'unblock',
        rowId: r.rowId,
        prompt: `${r.rowId} is blocked${r.consequence ? ` — ${r.consequence}` : ''}`,
        options: ['unblock', 'waive'],
      });
    } else if (r.resolved === 'fail') {
      decisions.push({
        kind: 'replan',
        rowId: r.rowId,
        prompt: `${r.rowId} failed under cross-check — re-plan the work, waive with a reason, or carry it forward`,
        options: ['replan', 'waive', 'carry'],
      });
    } else if (r.resolved === 'unproven') {
      decisions.push({
        kind: 'prove',
        rowId: r.rowId,
        prompt: `${r.rowId} is unproven — run a falsification with a working instrument, or waive it`,
        options: ['prove', 'waive'],
      });
    } else {
      decisions.push({
        kind: 'start',
        rowId: r.rowId,
        prompt: `${r.rowId} is unverified with no claim or witness — assign a builder, or drop the row`,
        options: ['assign', 'drop'],
      });
    }
  }
  if (!decisions.length && rows.length) {
    decisions.push({
      kind: 'ship',
      prompt: 'every row is green — approve the release, or keep testing',
      options: ['ship', 'keep-testing'],
    });
  }
  return decisions;
}

export async function portfolioRoutes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });

    const projects = await prisma.project.findMany({
      where: { orgId: membership.orgId },
      orderBy: { createdAt: 'asc' },
    });

    const result = [];
    for (const project of projects) {
      const [ledgerRows, verdicts] = await Promise.all([
        prisma.ledgerRow.findMany({ where: { projectId: project.id }, orderBy: { ts: 'asc' } }),
        prisma.verdict.findMany({ where: { projectId: project.id }, orderBy: { ts: 'asc' } }),
      ]);
      const latest = new Map<string, (typeof ledgerRows)[number]>();
      for (const r of ledgerRows) latest.set(r.rowId, r);

      const rows: ResolvedRow[] = [...latest.values()].map((r) => {
        const v = verdicts.filter((x) => x.rowId === r.rowId);
        const { resolved, witnessedBy, builderClaim } = resolveRow(
          r.status,
          v.map((x) => ({
            verdict: x.verdict,
            attestedNotWitnessed: x.attestedNotWitnessed,
            falsification: x.falsification,
            instrumentControl: x.instrumentControl,
            seat: x.seat,
          })),
        );
        return {
          rowId: r.rowId,
          requirement: r.requirement,
          environment: r.environment,
          ledgerStatus: r.status,
          resolved,
          witnessedBy,
          builderClaim,
          consequence: r.consequence,
        };
      });

      const decisions = openDecisions(rows);
      result.push({
        slug: project.slug,
        name: project.name,
        status: project.status,
        rows,
        openDecisions: decisions,
        nextDecision: decisions[0] ?? null,
      });
    }

    // org-level: open work (witness/unblock/replan/prove/start) outranks a
    // green project waiting on its ship decision
    const withWork = result.find((p) => p.nextDecision && p.nextDecision.kind !== 'ship');
    const ship = result.find((p) => p.nextDecision && p.nextDecision.kind === 'ship');
    const top = withWork ?? ship;

    return {
      org: membership.orgId,
      projects: result,
      nextDecision: top ? { project: top.slug, ...top.nextDecision } : null,
    };
  });
}
