// CREW — the runner (Phase 7).
//
//   ONE CREW = ONE PROCESS GROUP. The supervisor is spawned detached (own
//   PGID); its workers inherit the group. Kill = SIGTERM to the GROUP, a
//   grace period, then SIGKILL to the group.
//
//   KILL MID-TASK: the partial artifacts stay on disk and on the board
//   (Task.artifactRefs + the run's partials listing), and the attempt is
//   recorded in the stream as `killed` — an append-only record, so the
//   kill itself is auditable.
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNS_DIR = process.env.JATIN_RUNS_DIR || join(REPO_ROOT, 'runs');
const SUPERVISOR = join(REPO_ROOT, 'scripts', 'crew-supervisor.mjs');
const KILL_GRACE_MS = 5500;

const killTimers = new Map<string, NodeJS.Timeout>();

function stateOf(runId: string): Record<string, unknown> | null {
  const f = join(RUNS_DIR, runId, 'state.json');
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
  } catch {
    return null; // fail open — the stream + Task row are the record
  }
}

function partialViews(outDir: string) {
  const views: { path: string; bytes: number; lines: number; tail: string[] }[] = [];
  for (let i = 1; i <= 8; i++) {
    const p = join(outDir, `partial-${i}.log`);
    if (existsSync(p)) {
      const st = statSync(p);
      const content = readFileSync(p, 'utf8');
      const all = content.split('\n').filter(Boolean);
      views.push({
        path: p,
        bytes: st.size,
        lines: all.length,
        tail: all.slice(-5).map((l) => l.slice(0, 140)),
      });
    }
  }
  return views;
}

// append a stream event for a scope — seq read + write in ONE serializable
// transaction with retry (same law as the stream route)
async function appendTaskEvent(projectId: string, body: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const last = await tx.event.findFirst({ where: { scopeId: projectId }, orderBy: { seq: 'desc' }, select: { seq: true } });
          await tx.event.create({
            data: {
              scopeId: projectId,
              projectId,
              seq: (last?.seq ?? 0n) + 1n,
              type: 'task',
              actor: 'crew-runner',
              body: body as InputJsonValue,
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return;
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002' && attempt < 5) continue;
      throw e;
    }
  }
}

// record a final-state transition ONCE. The compare-and-swap on the Task
// status is atomic in the DB, so the kill timer and a concurrent GET can
// both call this and only the first performs the transition + appends the
// stream event. (The stream is append-only; a transition is recorded once.)
async function recordState(runId: string, status: 'killed' | 'done') {
  const outDir = join(RUNS_DIR, runId);
  const task = await prisma.task.findFirst({ where: { artifactRefs: { path: ['$taskId'], equals: runId } } });
  if (!task) return;

  const cas = await prisma.task.updateMany({
    where: { id: task.id, status: { notIn: ['killed', 'done'] } },
    data: {
      status,
      artifactRefs: {
        $taskId: runId,
        outDir,
        partials: partialViews(outDir).map((p) => p.path),
        at: new Date().toISOString(),
      } as unknown as InputJsonValue,
    },
  });
  if (cas.count === 0) return; // someone else recorded it first

  const partials = partialViews(outDir);
  await appendTaskEvent(task.projectId, {
    taskId: task.id,
    title: task.title,
    status,
    attempt: 'recorded',
    partials: partials.map((p) => ({ path: p.path, bytes: p.bytes, lines: p.lines })),
  }).catch((e) => console.error('[crew] event write failed', e));
}

export async function crewRoutes(app: FastifyInstance) {
  // list the crew runs for a project (default: the org's first project)
  app.get('/', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const q = req.query as { slug?: string };
    const project = q.slug
      ? await prisma.project.findFirst({ where: { slug: q.slug, orgId: membership.orgId } })
      : await prisma.project.findFirst({ where: { orgId: membership.orgId }, orderBy: { createdAt: 'asc' } });
    if (!project) return reply.code(404).send({ error: 'no such project' });

    const tasks = await prisma.task.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const runs = tasks.map((t) => {
      const refs = (t.artifactRefs ?? {}) as Record<string, unknown>;
      const runId = typeof refs.$taskId === 'string' ? refs.$taskId : null;
      const state = runId ? stateOf(runId) : null;
      const partials = runId ? partialViews(join(RUNS_DIR, runId)) : [];
      return {
        runId,
        taskId: t.id,
        title: t.title,
        taskStatus: t.status,
        crewStatus: (state?.status as string) ?? (t.status === 'in_progress' ? 'unknown' : t.status),
        roles: (state?.roles as string[] | undefined) ?? (Array.isArray(refs.roles) ? (refs.roles as string[]) : null),
        partials,
        createdAt: t.createdAt.toISOString(),
      };
    });
    return { project: project.slug, runs };
  });

  // start a crew on a project task
  app.post('/', async (req, reply) => {
    // a crew IS a process group — a serverless function cannot spawn one.
    // Loud 501 with the reason, never a silent no-op (law 1.6).
    if (process.env.JATIN_RUNTIME === 'serverless') {
      return reply.code(501).send({
        error: 'crew runner spawns a process group — impossible on a serverless function. Run the API on a persistent host for crews; verdicts (attested) still work here.',
      });
    }
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const b = (req.body ?? {}) as {
      slug?: string; title?: string; workers?: number; durationSec?: number;
      roles?: { builder?: number; auditor?: number };
    };
    const project = await prisma.project.findFirst({ where: { slug: b.slug, orgId: membership.orgId } });
    if (!project) return reply.code(404).send({ error: 'no such project' });

    const workers = Math.min(8, Math.max(1, Math.round(b.workers ?? 2)));
    const durationSec = Math.min(600, Math.max(1, Math.round(b.durationSec ?? 30)));
    const title = (b.title ?? `crew run ${new Date().toISOString()}`).slice(0, 200);

    // composition: builders do the work, auditors review the builders'
    // partials as they land. legacy `workers` (no roles) = all builders.
    const rb = Math.min(8, Math.max(0, Math.round(b.roles?.builder ?? 0)));
    const ra = Math.min(8, Math.max(0, Math.round(b.roles?.auditor ?? 0)));
    const roleList: string[] =
      rb + ra > 0
        ? [...Array(rb).fill('builder'), ...Array(ra).fill('auditor')]
        : Array(workers).fill('builder');

    const task = await prisma.task.create({
      data: { projectId: project.id, title, status: 'in_progress' },
    });
    const runId = randomUUID().replace(/-/g, '').slice(0, 12);
    const outDir = join(RUNS_DIR, runId);
    mkdirSync(outDir, { recursive: true });

    const child = spawn(process.execPath, [SUPERVISOR, runId, outDir, String(workers), title, String(durationSec * 1000), roleList.join(',')], {
      detached: true,
      stdio: 'ignore',
      cwd: REPO_ROOT,
    });
    child.unref();

    await prisma.task
      .update({
        where: { id: task.id },
        data: { artifactRefs: { $taskId: runId, outDir, roles: roleList } as unknown as InputJsonValue },
      })
      .catch(() => {});

    await appendTaskEvent(project.id, {
      taskId: task.id,
      title,
      status: 'started',
      runId,
      workers,
      roles: roleList,
      durationSec,
      pgid: child.pid,
    }).catch((e) => console.error('[crew] event write failed', e));

    return reply.code(201).send({
      runId,
      taskId: task.id,
      pgid: child.pid,
      status: 'running',
      outDir,
      project: project.slug,
    });
  });

  // kill the whole process group — SIGTERM, grace, then SIGKILL
  app.post('/:runId/kill', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { runId } = req.params as { runId: string };
    const state = stateOf(runId);
    if (!state) return reply.code(404).send({ error: 'no such run' });
    const pgid = Number(state.pgid);

    if (killTimers.has(runId)) return { runId, status: state.status, note: 'kill already in flight' };
    if (state.status === 'killed' || state.status === 'done') {
      await recordState(runId, state.status === 'killed' ? 'killed' : 'done');
      return { runId, status: state.status, note: 'already ' + state.status };
    }

    let alive = true;
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      alive = false;
    }
    if (alive) console.log(`[crew] SIGTERM → group ${pgid} (run ${runId})`);

    killTimers.set(
      runId,
      setTimeout(async () => {
        killTimers.delete(runId);
        let stillAlive = true;
        try {
          process.kill(-pgid, 0);
        } catch {
          stillAlive = false;
        }
        if (stillAlive) {
          console.log(`[crew] grace expired — SIGKILL → group ${pgid}`);
          try {
            process.kill(-pgid, 'SIGKILL');
          } catch {
            /* gone */
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        await recordState(runId, 'killed').catch((e) => console.error('[crew] kill record failed', e));
      }, KILL_GRACE_MS),
    );

    return { runId, status: alive ? 'killing' : 'dead', pgid, graceMs: KILL_GRACE_MS };
  });

  // the run — state, task, partials (the board), attempts from the stream
  app.get('/:runId', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const { runId } = req.params as { runId: string };
    const state = stateOf(runId);
    if (!state) return reply.code(404).send({ error: 'no such run' });

    const outDir = join(RUNS_DIR, runId);
    const task = await prisma.task.findFirst({ where: { artifactRefs: { path: ['$taskId'], equals: runId } } });
    if (!task) return reply.code(404).send({ error: 'no such run' });

    // lazy sync: the supervisor wrote the final state; reflect it once
    if (state.status === 'done' && task.status !== 'done') await recordState(runId, 'done');
    if (state.status === 'killed' && task.status !== 'killed') await recordState(runId, 'killed');

    const refreshed = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    const attempts = await prisma.event.findMany({
      where: { projectId: task.projectId, type: 'task', body: { path: ['taskId'], equals: task.id } },
      orderBy: { seq: 'asc' },
    });

    return {
      runId,
      status: state.status,
      pgid: state.pgid,
      startedAt: state.startedAt,
      workers: state.workers,
      task: {
        id: refreshed.id,
        title: refreshed.title,
        status: refreshed.status,
        artifactRefs: refreshed.artifactRefs,
      },
      partials: partialViews(outDir),
      attempts: attempts.map((a) => ({ seq: a.seq.toString(), at: a.at.toISOString(), body: a.body })),
    };
  });
}
