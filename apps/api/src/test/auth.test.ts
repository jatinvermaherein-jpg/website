// Phase 0 acceptance — the O3 loop, reproducible by a stranger:
// register → pending → login refused → operator verifies → login works.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv(); // tests run without server.ts — load .env (JWT_SECRET, ADMIN_PASSWORD)

test('O3: register → pending → operator verify → login', async () => {
  const app = await buildApp();
  await app.ready();

  const password = 'password123';
  const stamp = Date.now().toString(36);
  const username = `t${stamp}`; // the account under test
  const other = `o${stamp}`; // a regular verified user (to prove non-operators can't verify)

  // 1 · register creates a pending account
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().status, 'pending');
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: other, password } });

  // 2 · login is refused while pending — with the reason, not a wall
  res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /pending verification/);

  // 3 · the operator (seeded from env) signs in
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  assert.ok(operator, 'operator must be seeded from env');
  res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  assert.equal(res.statusCode, 200);
  const opToken: string = res.json().token;
  assert.equal(res.json().operator, true);

  // 4 · a non-operator cannot verify
  const otherUser = await prisma.user.findUnique({ where: { username: other } });
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${otherUser!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200); // operator verifies the regular user first
  const otherLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: other, password } });
  const otherToken: string = otherLogin.json().token;
  const target = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target!.id}/verify`,
    headers: { authorization: `Bearer ${otherToken}` }, // regular user tries to verify
  });
  assert.equal(res.statusCode, 403);
  assert.match(res.json().error, /operator only/);

  // 5 · the operator verifies — and only now does login work
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'active');

  res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().token);

  // 6 · wrong password is still refused
  res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'wrong-password-9' } });
  assert.equal(res.statusCode, 401);

  await app.close();
});

test('law 6.3: an added key is write-only — no read path returns the secret', async () => {
  const app = await buildApp();
  await app.ready();

  const username = `k${Date.now().toString(36)}`;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const user = await prisma.user.findUnique({ where: { username } });
  await app.inject({
    method: 'POST',
    url: `/api/admin/users/${user!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const token: string = login.json().token;

  const secret = 'sk-test-' + 'x'.repeat(24);
  let res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: 'openai', label: 'demo', secret, limits: [{ kind: 'rpm', limit: 50, reservePct: 5 }] },
  });
  assert.equal(res.statusCode, 201);
  assert.ok(!JSON.stringify(res.json()).includes(secret), 'the response must not echo the secret');

  res = await app.inject({ method: 'GET', url: '/api/account/keys', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  assert.ok(!JSON.stringify(res.json()).includes(secret), 'the read path must not return the secret');
  assert.equal(res.json().keys[0].limits[0].kind, 'rpm');

  await app.close();
});
