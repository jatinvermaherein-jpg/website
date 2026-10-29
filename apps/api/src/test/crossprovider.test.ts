// Phase 4 acceptance — multi-provider: the alias ladder walks providers,
// and when a later hop serves, the response CARRIES THE FLAG (header + body
// + Request row). Degradation is never silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c4',
          choices: [{ message: { role: 'assistant', content: 'served' } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('Phase 4: alias ladder — cross-provider failover is flagged in the response', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  const username = `x${Date.now().toString(36)}`;
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

  // keys: groq capped at 1 rpm, openrouter uncapped
  res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: 'groq', label: 'g1', secret: 'gsk-x-1', limits: [{ kind: 'rpm', limit: 1, reservePct: 0 }] },
  });
  assert.equal(res.statusCode, 201);
  res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: 'openrouter', label: 'o1', secret: 'sk-or-x-1' },
  });
  assert.equal(res.statusCode, 201);

  // the alias: groq first, openrouter the fallback rung
  res = await app.inject({
    method: 'POST',
    url: '/api/account/aliases',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      alias: 'llama',
      targets: [
        { provider: 'groq', providerModelId: 'llama-x', priority: 10 },
        { provider: 'openrouter', providerModelId: 'llama-free', priority: 20 },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const aliases = (await app.inject({ method: 'GET', url: '/api/account/aliases', headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(aliases.aliases[0].targets.length, 2);

  // keep the rpm window stable across the three alias requests
  const guard = new Date().getUTCSeconds();
  if (guard > 55) await new Promise((r) => setTimeout(r, (60 - guard + 1) * 1000));

  // hop 0: groq serves, no flag
  const chat = (model: string) =>
    app.inject({
      method: 'POST',
      url: '/api/flow/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model, messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
  res = await chat('llama');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()._jatin.degraded, undefined);
  let row = await prisma.request.findFirst({ where: { orgId: org.orgId }, orderBy: { createdAt: 'desc' } });
  assert.equal(row!.modelServed, 'groq/llama-x');
  assert.equal(row!.status, 'ok');
  assert.equal(row!.degraded, false);

  // groq's minute is now spent — the next 'llama' rides the openrouter rung
  res = await chat('llama');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()._jatin.degraded, true);
  assert.match(res.json()._jatin.reason, /groq/);
  row = await prisma.request.findFirst({ where: { orgId: org.orgId }, orderBy: { createdAt: 'desc' } });
  assert.equal(row!.modelServed, 'openrouter/llama-free');
  assert.equal(row!.status, 'fallback');
  assert.equal(row!.degraded, true);

  // an exact model reference never degrades (single target, hop 0)
  res = await chat('openrouter/llama-free');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json()._jatin.degraded, undefined);

  // unknown alias — a plain sentence, not a wall
  res = await chat('nope-nope');
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /no alias "nope-nope"/);
});
