// Phase 7 acceptance — one crew = one process group. Kill = SIGTERM to the
// group, grace, then SIGKILL. Kill mid-task: the partial artifact stays
// visible on the board, and the attempt is recorded as KILLED.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

test('Phase 7: crew runner — group kill mid-task, partials stay, attempt KILLED', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const username = `c${Date.now().toString(36)}`;
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const target = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const token: string = login.json().token;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const HK = { authorization: `Bearer ${token}` }; // no body → no content-type
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  const slug = `c${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'C7', status: 'active' } });

  // ── the long crew that gets killed mid-task ─────────────────────────────
  res = await app.inject({ method: 'POST', url: '/api/crew', headers: H, payload: { slug, title: 'long task', workers: 2, durationSec: 120 } });
  assert.equal(res.statusCode, 201);
  const started = res.json();
  const runId: string = started.runId;
  const pgid: number = started.pgid;
  assert.ok(groupAlive(pgid), 'the crew is its own process group and it is alive');

  // let it work for a moment — partials must accumulate
  await sleep(1200);
  res = await app.inject({ method: 'GET', url: `/api/crew/${runId}`, headers: H });
  assert.equal(res.statusCode, 200);
  let run = res.json();
  assert.equal(run.status, 'running');
  assert.equal(run.partials.length, 2, 'two workers → two partial artifacts');
  for (const p of run.partials) assert.ok(p.lines > 2, `partial ${p.path} is accumulating work (${p.lines} lines)`);

  // ── KILL MID-TASK ────────────────────────────────────────────────────────
  res = await app.inject({ method: 'POST', url: `/api/crew/${runId}/kill`, headers: HK });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'killing');

  // grace (5.5s in the route) + supervisor's 3.2s mark → wait it out
  await sleep(6800);

  // the WHOLE group is gone (supervisor AND workers — the group kill hit both)
  assert.equal(groupAlive(pgid), false, 'SIGTERM→grace→SIGKILL killed the entire process group');

  // the partial artifact STAYS VISIBLE ON THE BOARD — not vaporized
  res = await app.inject({ method: 'GET', url: `/api/crew/${runId}`, headers: H });
  assert.equal(res.statusCode, 200);
  run = res.json();
  assert.equal(run.status, 'killed');
  assert.equal(run.task.status, 'killed');
  assert.equal(run.partials.length, 2, 'partials survived the kill');
  for (const p of run.partials) assert.ok(p.bytes > 0 && p.lines > 2, `partial kept on the board: ${p.lines} lines`);
  assert.ok(run.task.artifactRefs.partials?.length === 2, 'the Task row points at the partials (the board)');

  // the attempt is RECORDED AS KILLED — in the append-only stream
  const killed = run.attempts.filter((a: { body: { status: string } }) => a.body.status === 'killed');
  assert.equal(killed.length, 1, 'exactly one KILLED attempt record');
  assert.ok(killed[0].body.partials?.length === 2, 'the kill record carries the partials');

  // the Task row itself is durable
  const taskRow = await prisma.task.findUniqueOrThrow({ where: { id: run.task.id } });
  assert.equal(taskRow.status, 'killed');

  // ── a short crew that finishes → the RUN is done, the WORK is not ────────
  // A finished run used to write `done` straight onto the Task, closing it
  // with no auditor, no witness and no verdict. The runner produces work; an
  // auditor decides whether it is finished. So the task lands in `review`.
  res = await app.inject({ method: 'POST', url: '/api/crew', headers: H, payload: { slug, title: 'short task', workers: 1, durationSec: 1 } });
  assert.equal(res.statusCode, 201);
  const shortRunId: string = res.json().runId;
  await sleep(2600);
  res = await app.inject({ method: 'GET', url: `/api/crew/${shortRunId}`, headers: H });
  const done = res.json();
  assert.equal(done.status, 'done', 'the run itself is over');
  assert.equal(done.task.status, 'review', 'the task awaits an auditor — a runner cannot close its own work');
  assert.equal(done.partials[0]!.lines > 1, true);
});
