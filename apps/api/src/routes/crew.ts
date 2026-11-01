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
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { SEAT_SESSION_PREFIX, seatSha256 } from '../lib/seatauth.js';
import { decryptSecret } from '../lib/vault.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const RUNS_DIR = process.env.JATIN_RUNS_DIR || join(REPO_ROOT, 'runs');
const SUPERVISOR = join(REPO_ROOT, 'scripts', 'crew-supervisor.mjs');
const KILL_GRACE_MS = 5500;

const killTimers = new Map<string, NodeJS.Timeout>();

// D5 — find a run's task by its indexed column. Rows written before
// migration 0009 carry the id only inside artifactRefs, so fall back to the
// old JSON path once rather than losing an in-flight run.
async function taskByRun(runId: string) {
  const byColumn = await prisma.task.findUnique({ where: { runId } });
  if (byColumn) return byColumn;
  return prisma.task.findFirst({ where: { artifactRefs: { path: ['$taskId'], equals: runId } } });
}

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
  const task = await taskByRun(runId);
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

// ── the reaper (D6) ───────────────────────────────────────────────────────
// A run ends when its budget elapses. The supervisor records that in
// state.json — but it holds no database credentials and cannot write the bus,
// and the API's only paths to a terminal record were "someone hit Kill" and
// "someone opened the run page".
//
// So a run that expires on its own budget left no `killed` line at all. The
// protocol tells an EXTERNAL seat exactly the opposite: "when it ends, the bus
// gets the killed/done record — watch for it and stop." It never came. An
// agent following the protocol would run until a human noticed.
//
// This sweep closes it: every 10s, any open task whose state.json says
// killed/done gets its terminal record written once (recordState is already
// CAS-guarded, so racing with a kill or a GET is safe).
const REAP_MS = Number(process.env.JATIN_REAP_MS || 10_000);
let reaper: NodeJS.Timeout | null = null;

export async function reapEndedRuns(): Promise<string[]> {
  const recorded: string[] = [];
  try {
    const open = await prisma.task.findMany({
      where: { runId: { not: null }, status: 'in_progress' },
      select: { runId: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    for (const t of open) {
      if (!t.runId) continue;
      const status = stateOf(t.runId)?.status;
      if (status === 'killed' || status === 'done') {
        await recordState(t.runId, status).catch(() => {});
        recorded.push(t.runId);
      }
    }
  } catch {
    /* fail open — the sweep is a courtesy; state.json is the truth */
  }
  return recorded;
}

export function startRunReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => void reapEndedRuns(), REAP_MS);
  reaper.unref?.();
}

export async function crewRoutes(app: FastifyInstance) {
  // every run gets a terminal record on the bus, even when its budget simply
  // elapsed and nobody ever opened the page (D6)
  startRunReaper();

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
        seats: (state?.seats as string[] | undefined) ?? (Array.isArray(refs.seats) ? (refs.seats as string[]) : []),
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
      seats?: { name: string; command?: string }[];
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

    // REAL seats on the bus: named agents, each either spawned into this
    // process group (command) or external (connects with its seat key from
    // anywhere — its heartbeat IS its presence). A spawned seat gets a
    // run-scoped session token (never a standing secret on this host).
    // EVERY active seat on the project is on every run. A seat is a member of
    // the team, not an opt-in per run — a run that silently dropped the
    // auditor was the normal case, and it is not a decision a human should
    // have to remember to tick.
    //
    // An explicit `seats` array still wins (it is how a spawned command is
    // given), but omitting it attaches the whole team, external by default.
    const seatSpecs: { name: string; role: string; command: string; token: string }[] = [];
    const externalSeats: string[] = [];
    const requestedSeats: { name: string; command?: string }[] = Array.isArray(b.seats)
      ? (b.seats as { name: string; command?: string }[])
      : (
          await prisma.seat.findMany({
            where: { orgId: membership.orgId, status: { notIn: ['archived', 'vacant'] }, projects: { some: { projectId: project.id } } },
            orderBy: { createdAt: 'asc' },
            select: { name: true },
          })
        ).map((x) => ({ name: x.name }));
    if (requestedSeats.length) {
      for (const entry of requestedSeats) {
        if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) continue;
        const seat = await prisma.seat.findFirst({
          where: { orgId: membership.orgId, name: entry.name.trim().toLowerCase(), projects: { some: { projectId: project.id } } },
        });
        if (!seat) return reply.code(404).send({ error: `no seat named ${entry.name} on this project` });
        const command = typeof entry.command === 'string' ? entry.command.trim() : '';
        if (command) {
          const token = SEAT_SESSION_PREFIX + randomBytes(24).toString('base64url');
          await prisma.session.create({
            data: { seatId: seat.id, tokenHash: seatSha256(token), expiresAt: new Date(Date.now() + durationSec * 1000 + 3_600_000) },
          });
          seatSpecs.push({ name: seat.name, role: seat.role, command, token });
        } else {
          externalSeats.push(seat.name);
        }
      }
    }
    const allSeats = [...seatSpecs.map((x) => x.name), ...externalSeats];
    if (roleList.length === 0 && allSeats.length === 0) return reply.code(422).send({ error: 'assign at least one worker or seat' });

    const runId = randomUUID().replace(/-/g, '').slice(0, 12);
    const task = await prisma.task.create({
      data: { projectId: project.id, title, status: 'in_progress', runId },
    });
    const outDir = join(RUNS_DIR, runId);
    mkdirSync(outDir, { recursive: true });
    if (seatSpecs.length) {
      // project env: every spawned seat gets the project's environment, so
      // an agent has the same access the operator does. Decrypted once, at
      // spawn time, audited per value. The file is 0600 and holds secrets —
      // same contract as the run tokens: never argv, never stdout.
      const envRows = await prisma.projectEnv.findMany({ where: { projectId: project.id } });
      const projectEnv: Record<string, string> = {};
      for (const row of envRows) {
        try {
          projectEnv[row.name] = decryptSecret(row.valueStored, {
            prisma,
            actor: 'crew-runner',
            action: 'env.inject',
            target: `${project.slug}/${row.name}`,
          });
        } catch (e) {
          console.error(`[crew] env ${row.name} could not be decrypted — run continues without it`, e);
        }
      }
      // the spec is a file, not argv — the tokens must not show in the process list
      writeFileSync(
        join(outDir, 'seats.json'),
        JSON.stringify({ slug: project.slug, seats: seatSpecs, env: projectEnv }, null, 2),
        { mode: 0o600 },
      );
    }

    const child = spawn(process.execPath, [SUPERVISOR, runId, outDir, String(roleList.length), title, String(durationSec * 1000), roleList.join(',')], {
      detached: true,
      stdio: 'ignore',
      cwd: REPO_ROOT,
    });
    child.unref();

    await prisma.task
      .update({
        where: { id: task.id },
        data: { artifactRefs: { $taskId: runId, outDir, roles: roleList, seats: allSeats } as unknown as InputJsonValue },
      })
      .catch(() => {});

    await appendTaskEvent(project.id, {
      taskId: task.id,
      title,
      status: 'started',
      runId,
      workers,
      roles: roleList,
      seats: allSeats,
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
      seats: allSeats, // say who rode along — a run never silently drops the team
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
    const task = await taskByRun(runId);
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
