// Phase 9 acceptance — human posts, sees a live rejection in the feed
// within seconds. The refusal is telemetry: a well-formed `system` event
// describing the malformed line (which is itself never written), so the
// feed shows the refusal live and "same reason twice = schema defect" can
// be counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import type { Response } from 'light-my-request';

loadDotEnv();

test('Phase 9: interactive feed — post, live rejection within seconds, stream never blocks', async (t) => {
  const app = await buildApp();
  await app.ready();

  const username = `i${Date.now().toString(36)}`;
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
  const slug = `i${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'I9', status: 'active' } });
  t.after(() => app.close());

  const post = (payload: object): Promise<Response> => app.inject({ method: 'POST', url: `/api/projects/${slug}/stream`, headers: H, payload });
  const read = (qs: string): Promise<Response> => app.inject({ method: 'GET', url: `/api/projects/${slug}/stream${qs}`, headers: H });

  // the human posts a normal line
  res = await post({ type: 'message', body: { text: 'hello from the human' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().seq, '1');

  // the human posts a MALFORMED line — refused at post, feed shows the refusal
  const t0 = Date.now();
  res = await post({ type: 'message', body: 'not-an-object' });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.json().violations, ['body must be an object']);

  // the feed (stream read) shows the refusal LIVE — and fast
  res = await read('?afterSeq=1');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `refusal visible within seconds (took ${elapsed}ms)`);
  const stream = res.json();
  assert.equal(stream.events.length, 1, 'exactly one new line: the refusal telemetry');
  const refusal = stream.events[0];
  assert.equal(refusal.type, 'system');
  assert.equal(refusal.body.rejection, true);
  assert.equal(refusal.body.type, 'message');
  assert.deepEqual(refusal.body.violations, ['body must be an object']);
  assert.equal(refusal.corrupt, undefined, 'the telemetry line itself is well-formed');

  // the malformed line itself is NOT in the stream
  const all = (await read('?afterSeq=0')).json();
  assert.equal(all.events.length, 2);
  assert.ok(!all.events.some((e: { type: string; body: unknown }) => e.type === 'message' && typeof e.body === 'string'));

  // the stream never BLOCKS on a bad line — the next good line lands
  res = await post({ type: 'answer', body: { text: 'still flowing' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().seq, '3');

  // same refusal reason TWICE = countable (the schema-defect signal)
  await post({ type: 'message', body: 'not-an-object-again' });
  const all2 = (await read('?afterSeq=0')).json();
  const rejections = all2.events.filter((e: { type: string; body: { rejection?: boolean; violations?: string[] } }) =>
    e.type === 'system' && e.body.rejection && e.body.violations?.includes('body must be an object'),
  );
  assert.equal(rejections.length, 2, 'two identical refusals on the record — a stranger can count the defect');
});
