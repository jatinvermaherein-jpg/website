// Hardening acceptance — the four fixes, as behaviour rather than as claims.
//
//   D1  a seat cannot speak as another name
//   D2  issuing or revoking a credential is an operator act
//   D3  no verdict before admission
//   plus the three new systems: project env, versioned docs, the brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

test('Hardening: D1 impersonation, D2 operator, D3 admission, env, docs, brief', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  // ── an operator, and a plain member, so D2 is testable ──────────────────
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;

  const username = `h${Date.now().toString(36)}`;
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  const member = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({ method: 'POST', url: `/api/admin/users/${member!.id}/verify`, headers: { authorization: `Bearer ${opToken}` } });
  assert.equal(res.statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const memberToken: string = login.json().token;

  const opOrg = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;
  const slug = `h${Date.now().toString(36)}`;
  const project = await prisma.project.create({
    data: { orgId: opOrg.orgId, slug, name: 'Hardening', status: 'active' },
  });

  const asOp = { authorization: `Bearer ${opToken}` };
  const asMember = { authorization: `Bearer ${memberToken}` };

  // ── D2 — a member cannot mint a credential ─────────────────────────────
  res = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/seats`,
    headers: asMember,
    payload: { name: 'rogue-auditor', role: 'auditor' },
  });
  assert.equal(res.statusCode, 403, 'D2: a non-operator must not be able to open a seat');
  assert.match(res.json().error, /operator only/);

  // the operator can
  res = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/seats`,
    headers: asOp,
    payload: { name: 'auditor-1', role: 'auditor' },
  });
  assert.equal(res.statusCode, 201);
  const seatKey: string = res.json().key;
  assert.match(seatKey, /^jat_s_/);
  assert.equal(seatKey.length, 49);

  res = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/seats`,
    headers: asOp,
    payload: { name: 'builder-1', role: 'builder' },
  });
  const builderKey: string = res.json().key;

  const seatHeaders = { authorization: `Bearer ${seatKey}` };
  const post = (body: unknown, headers: Record<string, string> = seatHeaders) =>
    app.inject({ method: 'POST', url: `/api/projects/${slug}/stream`, headers, payload: body as never });

  // ── D3 — no authority before admission ─────────────────────────────────
  res = await post({
    type: 'verdict',
    body: { rowId: 'R-1', seat: 'auditor-1', direction: 'assert', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'repo' }] },
  });
  assert.equal(res.statusCode, 409, 'D3: a verdict before admission must be refused');
  assert.match(res.json().error, /has not admitted itself/);

  // a greeting is allowed before admission — attention, not authority
  res = await post({ type: 'message', body: { text: 'I am here, reading the bus' } });
  assert.equal(res.statusCode, 201);

  // a hollow admission is refused
  res = await post({ type: 'admission', body: { takes: 'ok', stale: 'x', doesNotUnderstand: 'y' } });
  assert.equal(res.statusCode, 422);
  assert.match(JSON.stringify(res.json()), /at least 3 characters/);

  // a real admission is accepted
  res = await post({
    type: 'admission',
    body: {
      takes: 'audit of the crew stream hardening',
      stale: 'the protocol doc says a seat cannot impersonate — the code did not enforce it',
      doesNotUnderstand: 'why Artifact and Ruleset were in the schema with no routes',
    },
  });
  assert.equal(res.statusCode, 201);
  const seatRow = await prisma.seat.findFirst({ where: { name: 'auditor-1', orgId: opOrg.orgId } });
  assert.ok(seatRow?.admittedAt, 'the seat must be marked admitted after a real admission');

  // and now the verdict is allowed
  res = await post({
    type: 'verdict',
    body: { rowId: 'R-1', seat: 'auditor-1', direction: 'assert', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'repo' }] },
  });
  assert.equal(res.statusCode, 201);
  // …but still demoted, because there is no falsification attempt
  assert.equal(res.json().verdict, 'unproven');

  // ── D1 — a seat cannot speak as another name ───────────────────────────
  res = await post({ type: 'message', actor: 'builder-1', body: { text: 'I am the builder, honest' } });
  assert.equal(res.statusCode, 422, 'D1: impersonation must be refused');
  assert.match(res.json().error, /cannot speak as another name/);

  // the refusal is explicit about who the credential is
  assert.match(res.json().error, /auditor-1/);

  // posting without an actor speaks as itself
  res = await post({ type: 'message', body: { text: 'plain line' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().actor, 'auditor-1');

  // a human may still post under their own username
  res = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/stream`,
    headers: asOp,
    payload: { type: 'message', body: { text: 'operator speaking' } },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().actor, operator!.username);

  // ── project env — write-only ───────────────────────────────────────────
  res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${slug}/env/DATABASE_PASSWORD`,
    headers: asOp,
    payload: { value: 'super-secret-value-123' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().version, 1);

  // a member cannot write env
  res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${slug}/env/DATABASE_PASSWORD`,
    headers: asMember,
    payload: { value: 'nope' },
  });
  assert.equal(res.statusCode, 403);

  // the read path is names and masks — and the raw value appears nowhere
  res = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env`, headers: asOp });
  assert.equal(res.statusCode, 200);
  const envList = res.json().env as { name: string; mask: string }[];
  assert.equal(envList.length, 1);
  assert.equal(envList[0]!.name, 'DATABASE_PASSWORD');
  assert.ok(!res.body.includes('super-secret-value-123'), 'law 6.3: no read path may return a value');

  // rotation keeps history, still no values
  res = await app.inject({
    method: 'PUT',
    url: `/api/projects/${slug}/env/DATABASE_PASSWORD`,
    headers: asOp,
    payload: { value: 'rotated-secret-456' },
  });
  assert.equal(res.json().version, 2);
  res = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env/DATABASE_PASSWORD/history`, headers: asOp });
  assert.equal(res.json().versions.length, 2);
  assert.ok(!res.body.includes('rotated-secret-456'));

  // a bad name is refused before it can poison a spawn environment
  res = await app.inject({ method: 'PUT', url: `/api/projects/${slug}/env/bad-name`, headers: asOp, payload: { value: 'x' } });
  assert.equal(res.statusCode, 422);

  // ── versioned documents ────────────────────────────────────────────────
  const publish = (payload: Record<string, unknown>, headers = asOp) =>
    app.inject({ method: 'POST', url: `/api/projects/${slug}/docs`, headers, payload });

  res = await publish({ slug: 'rules', kind: 'rules', title: 'Project rules', body: '# Rules\n\n1. one bus\n2. no verdict without falsification\n' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().version, 1);
  const sha1: string = res.json().sha256;

  // publishing the identical body is not a new version
  res = await publish({ slug: 'rules', kind: 'rules', title: 'Project rules', body: '# Rules\n\n1. one bus\n2. no verdict without falsification\n' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().unchanged, true);

  // a changed body is version 2, and version 1 is still fetchable
  res = await publish({ slug: 'rules', kind: 'rules', title: 'Project rules', body: '# Rules v2\n\n3. admit before you work\n' });
  assert.equal(res.json().version, 2);

  res = await app.inject({ method: 'GET', url: `/api/projects/${slug}/docs/rules?version=1`, headers: asOp });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().sha256, sha1, 'an old version must be retrievable and unchanged');

  // a builder seat (not lead/scribe) cannot publish
  res = await publish({ slug: 'spec', title: 'nope', body: 'x' }, { authorization: `Bearer ${builderKey}` });
  assert.equal(res.statusCode, 403);

  // a rules publish advances the project's active version
  const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
  assert.equal(after.activeRulesetVersion, 2);

  // ── the brief: same access as the operator, no secrets ─────────────────
  res = await app.inject({ method: 'GET', url: `/api/projects/${slug}/brief`, headers: seatHeaders });
  assert.equal(res.statusCode, 200);
  const brief = res.json();
  assert.equal(brief.project.slug, slug);
  assert.equal(brief.me.name, 'auditor-1');
  assert.equal(brief.me.role, 'auditor');
  assert.equal(brief.me.admitted, true);
  assert.equal(brief.rules.version, 2);
  assert.ok(brief.docs.length >= 1);
  assert.ok(brief.env.some((e: { name: string }) => e.name === 'DATABASE_PASSWORD'));
  assert.ok(!JSON.stringify(brief).includes('rotated-secret-456'), 'the brief must never carry a secret value');
  assert.ok(brief.team.some((s: { name: string }) => s.name === 'builder-1'));
  assert.equal(brief.team.find((s: { name: string }) => s.name === 'builder-1').admitted, false);

  // a seat not on this project sees nothing
  const otherSlug = `x${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: opOrg.orgId, slug: otherSlug, name: 'Other', status: 'active' } });
  res = await app.inject({ method: 'GET', url: `/api/projects/${otherSlug}/brief`, headers: seatHeaders });
  assert.equal(res.statusCode, 404);
});

// D6 — a run that ends by BUDGET EXPIRY must still land a terminal record on
// the bus. The supervisor writes state.json but has no DB access, and the API
// only recorded terminal state on an explicit Kill or when a human opened the
// run page. An external seat told to "watch for the killed record and stop"
// therefore waited forever.
test('D6: the reaper writes the terminal record for an expired run', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const { reapEndedRuns } = await import('../routes/crew.js');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opOrg = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;
  const slug = `r${Date.now().toString(36)}`;
  const project = await prisma.project.create({ data: { orgId: opOrg.orgId, slug, name: 'Reap', status: 'active' } });

  const runsDir = process.env.JATIN_RUNS_DIR || resolve(process.cwd(), '..', '..', 'runs');
  const runId = `reap${Date.now().toString(36)}`;
  mkdirSync(join(runsDir, runId), { recursive: true });
  writeFileSync(join(runsDir, runId, 'state.json'), JSON.stringify({ runId, status: 'killed', pgid: 1, startedAt: Date.now() }));

  const task = await prisma.task.create({ data: { projectId: project.id, title: 'expired run', status: 'in_progress', runId } });

  const before = await prisma.event.count({ where: { projectId: project.id } });
  assert.equal(before, 0, 'no terminal record before the sweep');

  const recorded = await reapEndedRuns();
  assert.ok(recorded.includes(runId), 'the sweep must pick up the expired run');

  const after = await prisma.event.findMany({ where: { projectId: project.id, type: 'task' }, orderBy: { seq: 'asc' } });
  assert.equal(after.length, 1, 'exactly one terminal record');
  assert.equal((after[0]!.body as { status?: string }).status, 'killed');

  const t2 = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(t2.status, 'killed');

  // running it again must not write a second record (CAS guard)
  await reapEndedRuns();
  const again = await prisma.event.count({ where: { projectId: project.id, type: 'task' } });
  assert.equal(again, 1, 'a second sweep must not duplicate the record');

  rmSync(join(runsDir, runId), { recursive: true, force: true });
});

// Seats are on every run — a run must never silently drop the team.
// Previously `seats: []` was the normal case because the dashboard made you
// tick a box, and the API attached nothing when the field was absent.
test('every active seat rides every run when seats are not specified', async (t) => {
  process.env.JATIN_RUNTIME = process.env.JATIN_RUNTIME || 'persistent';
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const asOp = { authorization: `Bearer ${opToken}` };
  const opOrg = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;

  const slug = `a${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: opOrg.orgId, slug, name: 'AutoSeat', status: 'active' } });

  for (const [name, role] of [['auditor', 'auditor'], ['builder-x', 'builder'], ['scout', 'scout']]) {
    const r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/seats`, headers: asOp, payload: { name, role } });
    assert.equal(r.statusCode, 201);
  }
  // a revoked seat must NOT be attached — its key is dead
  const gone = await app.inject({ method: 'POST', url: `/api/projects/${slug}/seats`, headers: asOp, payload: { name: 'gone', role: 'builder' } });
  await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/seats/${gone.json().seat.id}/revoke`,
    headers: asOp,
  });

  // start a crew WITHOUT naming seats
  const r = await app.inject({
    method: 'POST', url: '/api/crew', headers: asOp,
    payload: { slug, title: 'auto-attach', durationSec: 1, roles: { builder: 1, auditor: 1 } },
  });
  assert.equal(r.statusCode, 201);
  const seats: string[] = r.json().seats;
  assert.deepEqual(seats.sort(), ['auditor', 'builder-x', 'scout'], 'the whole live team must be attached');
  assert.ok(!seats.includes('gone'), 'a revoked seat must not be attached');
});
