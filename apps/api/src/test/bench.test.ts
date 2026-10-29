// Phase 10 acceptance — bench + fidelity:
//   1. a seat resumes from a manifest IN ONE command (digest-verified;
//      a tampered manifest is refused);
//   2. a `production` row refuses a `local-stack` verdict (the ladder
//      only runs upward).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import type { Response } from 'light-my-request';

loadDotEnv();

test('Phase 10: bench manifest resume in one command + fidelity ladder', async (t) => {
  const app = await buildApp();
  await app.ready();

  const username = `b${Date.now().toString(36)}`;
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
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  const slug = `b${Date.now().toString(36)}`;
  const project = await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'B10', status: 'active' } });
  const seat = await prisma.seat.create({ data: { orgId: org.orgId, name: 'bench-seat', role: 'builder' } });
  await prisma.seatProject.create({ data: { seatId: seat.id, projectId: project.id } });
  t.after(() => app.close());

  const post = (url: string, payload: object): Promise<Response> => app.inject({ method: 'POST', url, headers: H, payload });
  const get = (url: string): Promise<Response> => app.inject({ method: 'GET', url, headers: H });

  // some state to snapshot
  await post(`/api/projects/${slug}/rows`, { rowId: 'J-20', requirement: 'baseline row', bySeat: seat.id });
  await post(`/api/projects/${slug}/stream`, { type: 'message', body: { text: 'state to remember' } });

  // ── bench manifest ──────────────────────────────────────────────────────
  res = await post(`/api/projects/${slug}/seats/${seat.id}/bench`, {
    image: 'jatin-bench:dev-2026',
    packages: { dev: ['node@20'] },
    restore: 'cp -r bench-snapshot ./worktree',
  });
  assert.equal(res.statusCode, 201);
  const bench = res.json();
  assert.ok(bench.digest.startsWith('sha256:'));
  assert.equal(bench.snapshot.rows.length, 1);
  assert.equal(bench.snapshot.rows[0].rowId, 'J-20');
  assert.equal(bench.snapshot.rows[0].environment, 'local-stack', 'rows inherit their fidelity level into the manifest');

  // ── resume — ONE command ────────────────────────────────────────────────
  res = await post(`/api/projects/${slug}/seats/${seat.id}/resume`, {});
  assert.equal(res.statusCode, 200);
  const resumed = res.json();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.manifestId, bench.manifestId, 'no manifestId given → the seat takes its latest');
  assert.equal(resumed.digest, bench.digest);
  assert.equal(resumed.restored.rows[0].rowId, 'J-20');
  assert.ok(Number(resumed.restored.cursor) >= 2, 'the cursor came back from the manifest');
  const seatAfter = await prisma.seat.findUniqueOrThrow({ where: { id: seat.id } });
  assert.ok(seatAfter.lastHeartbeat, 'the resume is recorded on the seat');

  // ── a tampered manifest is refused ──────────────────────────────────────
  const bad = await prisma.benchManifest.create({
    data: { seatId: seat.id, image: 'jatin-bench:evil', restore: 'rm -rf /', digest: 'sha256:deadbeef' },
  });
  res = await post(`/api/projects/${slug}/seats/${seat.id}/resume`, { manifestId: bad.id });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /digest mismatch/);

  // ── the fidelity ladder ─────────────────────────────────────────────────
  // a production row demands production evidence
  res = await post(`/api/projects/${slug}/rows`, { rowId: 'J-21', requirement: 'prod gate', bySeat: seat.id, environment: 'production' });
  assert.equal(res.statusCode, 201);

  const verdictBody = (rowId: string, environment: string) => ({
    type: 'verdict',
    body: {
      rowId,
      seat: seat.id,
      direction: 'falsify',
      environment,
      verdict: 'pass',
      evidence: [{ kind: 'system-probe', ref: 'probe' }],
      falsification: { command: 'true', output_digest: 'sha256:x' },
      instrumentControl: { command: 'test 1 = 2', output_digest: 'sha256:y', expected_failure: true, failedAsExpected: true },
      attestedNotWitnessed: false,
    },
  });

  // a local-stack verdict on the production row — REFUSED
  res = await post(`/api/projects/${slug}/stream`, verdictBody('J-21', 'local-stack'));
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error, /production row refuses a local-stack verdict/);

  // staging is also below production — refused
  res = await post(`/api/projects/${slug}/stream`, verdictBody('J-21', 'staging'));
  assert.equal(res.statusCode, 422);

  // a production verdict — accepted (and still demoted per the D8 law,
  // because this one fakes the digests but includes both proof fields)
  res = await post(`/api/projects/${slug}/stream`, verdictBody('J-21', 'production'));
  assert.equal(res.statusCode, 201);

  // the ladder only runs UP: a production verdict on a local-stack row is fine
  res = await post(`/api/projects/${slug}/stream`, verdictBody('J-20', 'production'));
  assert.equal(res.statusCode, 201);
});
