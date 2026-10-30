// Gateway keys — the key a CLIENT uses to call the gateway (jkn_…).
// Acceptance:
//   1 · issue from the account surface → plaintext returned EXACTLY once;
//       no read path (list, usage, DB row) can ever return it again (law 6.3)
//   2 · the key drives the real gateway end-to-end (pool → upstream →
//       measured usage on the Request row, attributed to the key)
//   3 · detailed usage: per-key requests/tokens/cost in /api/flow/usage,
//       same data via session and via the key itself
//   4 · revoke = instant lockout, archive-not-delete (row + trail stay)
//   5 · org isolation: org B sees none of org A's keys; a foreign key
//       answers 401, never 403-with-leak
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'c1',
            choices: [{ message: { role: 'assistant', content: 'Hello from the fake provider' } }],
            usage: { prompt_tokens: 9, completion_tokens: 4 },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InjectApp = { inject: (o: object) => Promise<{ statusCode: number; json: () => any }> };

async function makeUser(app: InjectApp, password = 'password123') {
  const username = `gk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password } });
  assert.equal(res.statusCode, 201, 'register');
  const op = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: op!.username, password: process.env.ADMIN_PASSWORD! } });
  const opToken: string = opLogin.json().token;
  const target = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({ method: 'POST', url: `/api/admin/users/${target!.id}/verify`, headers: { authorization: `Bearer ${opToken}` } });
  assert.equal(res.statusCode, 200, 'verify');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(login.statusCode, 200, 'login');
  const token: string = login.json().token;
  await app.inject({ method: 'POST', url: '/api/account/keys', headers: { authorization: `Bearer ${token}` }, payload: { provider: 'groq', label: 'fake', secret: 'gk-fake-upstream-secret' } });
  return { username, token };
}

test('gateway keys: issue-once, real gateway traffic, detailed usage, instant revoke, org isolation', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  const a = await makeUser(app);
  const H = { authorization: `Bearer ${a.token}` };

  // 1 · issue — the plaintext exists exactly once
  let res = await app.inject({ method: 'POST', url: '/api/flow/keys', headers: H, payload: { name: 'mobile-app' } });
  assert.equal(res.statusCode, 201);
  const issued = res.json() as { id: string; name: string; prefix: string; key: string };
  assert.match(issued.key, /^jkn_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.prefix, issued.key.slice(0, 12));

  // law 6.3 — no read path returns the plaintext or the hash
  res = await app.inject({ method: 'GET', url: '/api/flow/keys', headers: H });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.payload.includes(issued.key), 'the list must not contain the plaintext');
  const row = await prisma.apiKey.findUnique({ where: { id: issued.id } });
  assert.equal(row!.keyHash, createHash('sha256').update(issued.key).digest('hex'));
  assert.ok(!JSON.stringify(res.json()).includes(row!.keyHash), 'no hash on the wire either');
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: H });
  assert.ok(!res.payload.includes(issued.key), 'usage must not leak the key');

  // 2 · the key drives the REAL gateway (pool → fake upstream → measured usage)
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' },
    payload: { model: 'groq/fake-model', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json()));
  const body = res.json() as { usage: { prompt_tokens: number; completion_tokens: number } };
  assert.equal(body.usage.prompt_tokens, 9, 'the provider\u2019s own numbers, never an estimate');
  const flowRow = await prisma.request.findFirst({ where: { apiKeyId: issued.id }, orderBy: { createdAt: 'desc' } });
  assert.ok(flowRow, 'the Request row is attributed to the gateway key');
  assert.equal(flowRow!.tokensIn, 9);
  assert.equal(flowRow!.tokensOut, 4);
  assert.equal(flowRow!.status, 'ok');
  assert.equal(flowRow!.degraded, false);

  // 3 · detailed usage — per-key breakdown, identical via session and via key
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${issued.key}` } });
  assert.equal(res.statusCode, 200);
  const viaKey = res.json() as { gatewayKeys: { name: string; requests: number; tokensIn: number; tokensOut: number }[]; requests: { apiKey?: { name: string } }[] };
  const mine = viaKey.gatewayKeys.find((k) => k.name === 'mobile-app')!;
  assert.equal(mine.requests, 1);
  assert.equal(mine.tokensIn, 9);
  assert.equal(mine.tokensOut, 4);
  assert.equal(viaKey.requests[0]!.apiKey?.name, 'mobile-app', 'the ledger row names the key that made it');
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: H });
  const viaSession = res.json() as { gatewayKeys: { name: string; requests: number }[] };
  assert.equal(viaSession.gatewayKeys.find((k) => k.name === 'mobile-app')!.requests, 1, 'same org, same ledger');

  // 5 · org isolation — org B sees none of org A's keys; foreign key = 401
  const b = await makeUser(app);
  res = await app.inject({ method: 'GET', url: '/api/flow/keys', headers: { authorization: `Bearer ${b.token}` } });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { keys: unknown[] }).keys.length, 0, 'org B has no gateway keys');
  assert.ok(!res.payload.includes(issued.prefix), 'org B cannot see org A\u2019s prefix');
  res = await app.inject({ method: 'POST', url: `/api/flow/keys/${issued.id}/revoke`, headers: { authorization: `Bearer ${b.token}` } });
  assert.equal(res.statusCode, 404, 'org B cannot touch org A\u2019s key');
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: 'Bearer jkn_fffffffffffffffffffffffffffffffffffffffffff', 'content-type': 'application/json' },
    payload: { model: 'groq/fake-model', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 401, 'a malformed/unknown key is refused');
  assert.equal((res.json() as { error: string }).error, 'unknown gateway key');

  // 4 · revoke — instant lockout, archive-not-delete
  res = await app.inject({ method: 'POST', url: `/api/flow/keys/${issued.id}/revoke`, headers: H });
  assert.equal(res.statusCode, 200);
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' },
    payload: { model: 'groq/fake-model', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 401);
  assert.equal((res.json() as { error: string }).error, 'gateway key revoked');
  res = await app.inject({ method: 'GET', url: '/api/flow/keys', headers: H });
  const after = (res.json() as { keys: { id: string; revokedAt: unknown }[] }).keys.find((k) => k.id === issued.id)!;
  assert.ok(after.revokedAt, 'the row stays (archive-not-delete) with its trail');
  const trail = await prisma.request.count({ where: { apiKeyId: issued.id } });
  assert.ok(trail >= 1, 'the Request trail is intact under the revoked key');

  // and the SESSION is unaffected by the key's revocation
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { ...H, 'content-type': 'application/json' },
    payload: { model: 'groq/fake-model', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 200, 'session traffic is independent of gateway keys');
});
