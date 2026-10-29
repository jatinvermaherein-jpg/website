// Phase 2 acceptance — multi-key pool: kill a key mid-run, the request
// survives, the failover is recorded, and the dead key is structurally
// retired (it never re-enters the pool).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

const DEAD = 'gsk-dead-key-0000000000';
const ALIVE = 'gsk-alive-key-1111111111';

function fakeUpstreamV2(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization ?? '';
      if (auth === `Bearer ${DEAD}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { stream?: boolean };
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"c2","choices":[{"delta":{"content":"survived"}}]}\n\n');
          res.write('data: {"id":"c2","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'c2',
              choices: [{ message: { role: 'assistant', content: 'survived' } }],
              usage: { prompt_tokens: 11, completion_tokens: 22 },
            }),
          );
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('Phase 2: dead first key — request survives, failover recorded, key retired', async (t) => {
  const up = await fakeUpstreamV2();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  const username = `p${Date.now().toString(36)}`;
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

  // dead key FIRST (oldest → tried first), alive key second
  for (const [label, secret] of [
    ['doomed', DEAD],
    ['healthy', ALIVE],
  ] as const) {
    res = await app.inject({
      method: 'POST',
      url: '/api/account/keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'groq', label, secret },
    });
    assert.equal(res.statusCode, 201);
  }
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  const doomed = await prisma.providerCredential.findFirst({ where: { orgId: org.orgId, label: 'doomed' } });
  const healthy = await prisma.providerCredential.findFirst({ where: { orgId: org.orgId, label: 'healthy' } });

  // the request: key #1 is dead, key #2 carries it
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/any', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('survived'));
  assert.equal(res.headers['x-jatin-degraded'], '1'); // degradation is flagged

  // the trail: attempt 1 errored on the doomed key, attempt 2 served via fallback
  const rows = await prisma.request.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.credentialId, doomed!.id);
  assert.equal(rows[0]!.status, 'error');
  assert.equal(rows[1]!.credentialId, healthy!.id);
  assert.equal(rows[1]!.status, 'fallback');
  assert.equal(rows[1]!.degraded, true);
  assert.equal(rows[1]!.tokensIn, 11); // real counts survived the failover
  assert.equal(rows[1]!.tokensOut, 22);

  // structural retirement: the doomed key is dead, the pool no longer contains it
  const doomedAfter = await prisma.providerCredential.findUniqueOrThrow({ where: { id: doomed!.id } });
  assert.equal(doomedAfter.status, 'dead');

  // the next request is clean: no failover, no degradation flag
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/any', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()._jatin.degraded, undefined);
  const lastRows = await prisma.request.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'desc' }, take: 1 });
  assert.equal(lastRows[0]!.status, 'ok');
  assert.equal(lastRows[0]!.degraded, false);
});
