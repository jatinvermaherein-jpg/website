// Phase 6 acceptance — the wedge: one typed stream, validate at post,
// fail open on read, cursor. Malformed line's verdict is REJECTED; a
// verdict without a falsification attempt is UNPROVEN; an instrument
// without a control is UNPROVEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

test('Phase 6: typed stream — post validation, verdict demotion, fail-open read, cursor', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const username = `s${Date.now().toString(36)}`;
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
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;

  // isolated project for this account's org. NOTE: no cleanup of Event or
  // Verdict rows — those tables are APPEND-ONLY (jatin_app cannot UPDATE or
  // DELETE them by grant, by design). Test records stay as the immutable
  // record that the test ran; each run uses a fresh unique slug.
  const slug = `t${Date.now().toString(36)}`;
  const project = await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'T6', status: 'active' } });

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/projects/${slug}/stream`, headers: { authorization: `Bearer ${token}` }, payload });
  const read = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/projects/${slug}/stream${qs}`, headers: { authorization: `Bearer ${token}` } });

  // a normal line
  res = await post({ type: 'message', body: { text: 'hello stream' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().seq, '1');

  // MALFORMED LINE — rejected at post, never written as itself. The refusal
  // IS written as `system` telemetry (Phase 9), so it consumes a seq.
  res = await post({ type: 'nonsense', body: {} });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().error, /not written/);
  res = await post({ type: 'message', body: { text: 'still flowing' } });
  assert.equal(res.json().seq, '3');

  // a malformed VERDICT line — also rejected (direction out of vocabulary)
  res = await post({
    type: 'verdict',
    body: { rowId: 'J-03', seat: 'w1', direction: 'sideways', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'repo', ref: 'x' }] },
  });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.json().violations, ['direction must be one of: assert, falsify']);

  // VERDICT WITHOUT A FALSIFICATION ATTEMPT — written, demoted to unproven
  const falsification = { command: 'npm test -- --grep planted', output_digest: 'sha256:abc' };
  const instrumentControl = { command: 'npm test -- --grep control', output_digest: 'sha256:def', expected_failure: 'assert 1 === 2' };
  res = await post({
    type: 'verdict',
    body: { rowId: 'J-01', seat: 'w1', direction: 'falsify', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'repo', ref: 'src/a.ts' }] },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'unproven');
  assert.deepEqual(res.json().coerced, ['no-falsification', 'no-instrument-control']);

  // FALSIFICATION WITHOUT AN INSTRUMENT CONTROL — still unproven
  res = await post({
    type: 'verdict',
    body: { rowId: 'J-02', seat: 'w1', direction: 'falsify', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'system-probe', ref: 'probe-1' }], falsification },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'unproven');
  assert.deepEqual(res.json().coerced, ['no-instrument-control']);

  // THE FULL VERDICT — falsification run, control in place — passes
  res = await post({
    type: 'verdict',
    body: { rowId: 'J-03', seat: 'w1', direction: 'falsify', environment: 'unit', verdict: 'pass', evidence: [{ kind: 'system-probe', ref: 'probe-2' }], falsification, instrumentControl },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'pass');
  assert.deepEqual(res.json().coerced, []);

  // the demotion law is durable — mirrored into Verdict rows, not just the stream
  const verdicts = await prisma.verdict.findMany({ where: { projectId: project.id }, orderBy: { ts: 'asc' } });
  assert.deepEqual(
    verdicts.map((v) => v.verdict),
    ['unproven', 'unproven', 'pass'],
  );

  // FAIL-OPEN READ: a line the reader cannot parse is flagged, not fatal.
  // (seqs so far: 1 message, 2 refusal, 3 message, 4 refusal, 5-7 verdicts)
  await prisma.event.create({ data: { scopeId: project.id, projectId: project.id, seq: 8n, type: 'message', actor: 'corrupt', body: 'garbage-string' } });
  res = await post({ type: 'message', body: { text: 'after the corrupt line' } });
  assert.equal(res.json().seq, '9');

  res = await read('?afterSeq=0');
  assert.equal(res.statusCode, 200);
  const stream = res.json();
  assert.equal(stream.events.length, 9);
  const corrupt = stream.events.find((e: { corrupt?: boolean }) => e.corrupt);
  assert.ok(corrupt, 'the corrupt line is visible and flagged');
  const refusals = stream.events.filter((e: { type: string; body: { rejection?: boolean } }) => e.type === 'system' && e.body.rejection);
  assert.equal(refusals.length, 2, 'the two refusals ride the stream as telemetry');
  assert.equal(stream.events[8]!.type, 'message');
  assert.equal(stream.events[8]!.body.text, 'after the corrupt line');

  // CURSOR: resuming without afterSeq picks up where this seat left off
  assert.equal(stream.nextCursor, '9');
  await post({ type: 'message', body: { text: 'cursor check' } });
  res = await read();
  const resumed = res.json();
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].body.text, 'cursor check');
  assert.equal(resumed.nextCursor, '10');
  res = await read(); // nothing new — cursor holds
  assert.equal(res.json().events.length, 0);
});
