// Phase 1 acceptance — Flow passthrough: one provider, streaming,
// real token counts (the provider's own numbers, never an estimate).
// The fake upstream below is a local OpenAI-compatible SSE server; the
// gateway code under test is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
        const j = JSON.parse(body) as { stream?: boolean };
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}\n\n');
          res.write('data: {"id":"c1","choices":[{"delta":{"content":"lo"}}]}\n\n');
          res.write('data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":13}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'c1',
              choices: [{ message: { role: 'assistant', content: 'Hello' } }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
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

test('Phase 1: flow passthrough — stream, real usage, no key = honest refusal', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  const username = `f${Date.now().toString(36)}`;
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

  // no key on this account yet → a direct provider/model reference is
  // refused without naming our stack (alias-only world); the refusal never
  // leaks a provider name
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/any-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /unknown model/);
  assert.ok(!res.body.includes('openrouter'));

  // add the key, then stream
  res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: 'groq', label: 'phase1', secret: 'gsk-fake-key-1234567890' },
  });
  assert.equal(res.statusCode, 201);

  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/event-stream/);
  assert.ok(res.body.includes('data:'));
  assert.ok(res.body.includes('Hel'));
  assert.ok(res.body.includes('[DONE]'));

  // the request row carries the provider's OWN usage numbers
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  const reqRow = await prisma.request.findFirst({ where: { orgId: org.orgId }, orderBy: { createdAt: 'desc' } });
  assert.ok(reqRow);
  assert.equal(reqRow!.status, 'ok');
  assert.equal(reqRow!.tokensIn, 7);
  assert.equal(reqRow!.tokensOut, 13);
  assert.equal(reqRow!.modelServed, 'groq/llama-3.3-70b-versatile');

  // non-streaming passthrough
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 200);
  const j = res.json();
  assert.equal(j.choices[0].message.content, 'Hello');
  assert.equal(j.usage.prompt_tokens, 5);
  assert.equal(j._jatin.usage_source, 'provider');

  // the usage read side — per key, with the mask, never the secret
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.statusCode, 200);
  const usage = res.json();
  assert.ok(usage.requests.length >= 2);
  assert.ok(usage.requests[0].credential.keyMask.startsWith('gsk-'));
  assert.ok(!JSON.stringify(usage).includes('gsk-fake-key-1234567890'));
});
