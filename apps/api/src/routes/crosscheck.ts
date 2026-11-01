// CREW — cross-check (Phase 8).
//
//   The auditor sits on a DIFFERENT provider than the builder. The builder's
//   claim is an attestation until someone RUNS the falsification; the witness
//   runs it here — command + instrument control — with digests, and posts the
//   verdict as WITNESSED (attestedNotWitnessed: false).
//
//   Resolution (read side, derived — law 2.1): a witnessed verdict decides
//   the row; an instrument that does not fail as expected poisons its own
//   verdict (unproven); an attested pass never closes a row.
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { REPO_ROOT } from '../lib/paths.js';
import { ENVIRONMENTS } from '../lib/envelope.js';
import { appendQuietly } from '../lib/append.js';

const COMMAND_TIMEOUT_MS = 15000;
const ROW_ID_RE = /^J-\d{1,4}$/;

function workdirOf(slug: string) {
  return join(REPO_ROOT, 'workspace', slug);
}

function runCommand(command: string, cwd: string): Promise<{ exitCode: number | null; digest: string; tail: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    let full = '';
    let killed = false;
    const child = exec(command, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, shell: '/bin/sh' }, (err, stdout, stderr) => {
      const code = (err as { code?: number | string } | null)?.code;
      const exitCode = typeof code === 'number' ? code : err ? 1 : 0;
      full = `${stdout}\n${stderr}`;
      resolvePromise({
        exitCode,
        digest: `sha256:${createHash('sha256').update(full).digest('hex')}`,
        tail: full.slice(-2000),
        timedOut: killed,
      });
    });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS + 500);
    child.on('exit', () => clearTimeout(timer));
  });
}

// the cross-check resolution (derived, never typed) — also used by the
// portfolio, which reads every project through the same law
export function resolveRow(
  ledgerStatus: string,
  verdicts: { verdict: string; attestedNotWitnessed: boolean; falsification: unknown; instrumentControl: unknown; seat: string }[],
): { resolved: string; witnessedBy: string | null; builderClaim: string | null } {
  const witnessed = verdicts.filter((v) => !v.attestedNotWitnessed && v.falsification !== null && v.falsification !== undefined);
  // an ATTESTED verdict (no falsification run) is a claim, not evidence. It
  // was demoted to unproven at post, so the persisted verdict says
  // "unproven" — the claim itself is what the row status must not trust.
  const claim = verdicts.find((v) => v.attestedNotWitnessed);

  if (witnessed.length) {
    // the most recent witnessed verdict decides — unless its instrument
    // misbehaved (a control that fails to fail poisons the whole run)
    const latest = witnessed[witnessed.length - 1]!;
    const control = latest.instrumentControl as { failedAsExpected?: boolean } | null;
    if (control && control.failedAsExpected === false) {
      return { resolved: 'unproven', witnessedBy: latest.seat, builderClaim: claim ? 'claimed (attested)' : null };
    }
    return { resolved: latest.verdict, witnessedBy: latest.seat, builderClaim: claim ? 'claimed (attested)' : null };
  }
  // no witness yet — an attested claim cannot close the row
  return { resolved: ledgerStatus, witnessedBy: null, builderClaim: claim ? 'claimed (attested)' : null };
}

export async function crosscheckRoutes(app: FastifyInstance) {
  async function projectOf(req: { params: { slug: string } }, membership: { orgId: string }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const project = await prisma.project.findFirst({ where: { slug: req.params.slug, orgId: membership.orgId } });
    if (!project) {
      reply.code(404).send({ error: 'no such project' });
      return null;
    }
    return project;
  }

  // register / transition a join-spine row (append-only)
  app.post('/:slug/rows', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const project = await projectOf(req as { params: { slug: string } }, membership, reply);
    if (!project) return;

    const b = (req.body ?? {}) as {
      rowId?: string;
      requirement?: string;
      status?: string;
      bySeat?: string;
      consequence?: string;
      environment?: string;
    };
    if (!b.rowId || !ROW_ID_RE.test(b.rowId)) return reply.code(422).send({ error: 'rowId must look like J-01' });
    const status = b.status ?? 'unverified';
    const allowed = ['unverified', 'pass', 'partial', 'fail', 'blocked', 'carried', 'unproven'];
    if (!allowed.includes(status)) return reply.code(422).send({ error: `status must be one of: ${allowed.join(', ')}` });
    const environment = b.environment ?? 'local-stack';
    if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
      return reply.code(422).send({ error: `environment must be one of: ${ENVIRONMENTS.join(', ')}` });
    }

    const row = await prisma.ledgerRow.create({
      data: {
        projectId: project.id,
        rowId: b.rowId,
        requirement: b.requirement ?? null,
        environment,
        status,
        bySeat: b.bySeat ?? user.username,
        consequence: b.consequence ?? null,
      },
    });
    await appendQuietly({
      projectId: project.id,
      type: 'ledger',
      actor: b.bySeat ?? user.username,
      body: { rowId: b.rowId, status, bySeat: b.bySeat ?? user.username, requirement: b.requirement ?? null, environment },
    });
    return reply.code(201).send({ rowId: row.rowId, status: row.status, ts: row.ts });
  });

  // the witness RUNS the falsification + the instrument control (digests)
  app.post('/:slug/falsify', async (req, reply) => {
    // running a falsification spawns a shell — impossible in a serverless
    // function. The law still works here: post an attested-not-witnessed
    // verdict (recorded as unproven until witnessed on a persistent host).
    if (process.env.JATIN_RUNTIME === 'serverless') {
      return reply.code(501).send({
        error: 'falsification RUN spawns a shell process — impossible on a serverless function. Post an attested verdict instead, or run the witness on a persistent host.',
      });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const project = await projectOf(req as { params: { slug: string } }, membership, reply);
    if (!project) return;

    const b = (req.body ?? {}) as {
      rowId?: string;
      command?: string;
      control?: { command?: string; expected_failure?: boolean };
      seat?: string;
    };
    if (!b.rowId || !ROW_ID_RE.test(b.rowId)) return reply.code(422).send({ error: 'rowId must look like J-01' });
    if (!b.command?.trim()) return reply.code(422).send({ error: 'command is required — a witness must RUN the falsification' });

    const workdir = workdirOf(project.slug);
    mkdirSync(workdir, { recursive: true });

    const falsification = await runCommand(b.command, workdir);
    const control = b.control?.command
      ? {
          result: await runCommand(b.control.command, workdir),
          expectedFailure: b.control.expected_failure ?? true,
        }
      : null;

    const failedAsExpected = control
      ? (control.expectedFailure ? (control.result.exitCode ?? 1) !== 0 : (control.result.exitCode ?? 1) === 0)
      : null;

    return {
      rowId: b.rowId,
      seat: b.seat ?? user.username,
      workdir,
      falsification: {
        command: b.command,
        exitCode: falsification.exitCode,
        passed: (falsification.exitCode ?? 1) === 0,
        output_digest: falsification.digest,
        tail: falsification.tail,
        timedOut: falsification.timedOut,
      },
      instrumentControl: control
        ? {
            command: b.control!.command,
            exitCode: control.result.exitCode,
            output_digest: control.result.digest,
            expected_failure: control.expectedFailure,
            failedAsExpected,
            tail: control.result.tail,
          }
        : null,
      note: control && failedAsExpected === false
        ? 'the instrument does not fail as expected — any verdict from this run is unproven'
        : null,
    };
  });

  // the board — rows with the cross-check RESOLUTION (derived on read)
  app.get('/:slug/rows', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const project = await projectOf(req as { params: { slug: string } }, membership, reply);
    if (!project) return;

    const latest = new Map<string, { status: string; ts: Date; bySeat: string | null; requirement: string | null }>();
    const ledgerRows = await prisma.ledgerRow.findMany({ where: { projectId: project.id }, orderBy: { ts: 'asc' } });
    for (const r of ledgerRows) latest.set(r.rowId, { status: r.status, ts: r.ts, bySeat: r.bySeat, requirement: r.requirement });
    const rowIds = [...latest.keys()];
    const verdicts = rowIds.length
      ? await prisma.verdict.findMany({ where: { projectId: project.id, rowId: { in: rowIds } }, orderBy: { ts: 'asc' } })
      : [];

    const rows = rowIds.map((rowId) => {
      const v = verdicts.filter((x) => x.rowId === rowId);
      const { resolved, witnessedBy, builderClaim } = resolveRow(
        latest.get(rowId)!.status,
        v.map((x) => ({
          verdict: x.verdict,
          attestedNotWitnessed: x.attestedNotWitnessed,
          falsification: x.falsification,
          instrumentControl: x.instrumentControl,
          seat: x.seat,
        })),
      );
      return {
        rowId,
        requirement: latest.get(rowId)!.requirement,
        ledger: latest.get(rowId)!,
        resolved,
        witnessedBy,
        builderClaim,
        verdicts: v.map((x) => ({
          seat: x.seat,
          direction: x.direction,
          environment: x.environment,
          verdict: x.verdict,
          attestedNotWitnessed: x.attestedNotWitnessed,
          witnessed: !x.attestedNotWitnessed && x.falsification != null,
          ts: x.ts,
        })),
      };
    });
    return { project: project.slug, rows };
  });
}
