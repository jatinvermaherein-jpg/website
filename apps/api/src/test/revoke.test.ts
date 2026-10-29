// Phase 5 acceptance (account side) — add key → request works →
// revoke → the key stops serving (locked out) and stays archived,
// not deleted (the trail that references it survives).
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
          id: 'c5',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 4, completion_tokens: 4 },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('Phase 5: revoke a key — locked out, archived, trail intact', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  const username = `r${Date.now().toString(36)}`;
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

  res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${token}` },
    payload: { provider: 'groq', label: 'solo', secret: 'gsk-solo-12345' },
  });
  assert.equal(res.statusCode, 201);
  const keyId = res.json().id;

  const chat = () =>
    app.inject({
      method: 'POST',
      url: '/api/flow/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'groq/any', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });

  // works while active
  res = await chat();
  assert.equal(res.statusCode, 200);

  // revoke
  res = await app.inject({
    method: 'POST',
    url: `/api/account/keys/${keyId}/revoke`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'revoked');

  // locked out — with the plain reason, and the key archived (still there)
  res = await chat();
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /no active groq key/);
  const row = await prisma.providerCredential.findUniqueOrThrow({ where: { id: keyId } });
  assert.equal(row.status, 'revoked');
  assert.ok(row.secretStored.length > 0, 'the archived row keeps its (encrypted) record');

  // the earlier request still reads back, crediting the revoked key
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${token}` } });
  const usage = res.json();
  assert.equal(usage.requests[0].credential.id, keyId);
  assert.equal(usage.requests[0].credential.status, 'revoked');
  assert.equal(usage.requests[0].tokensIn, 4);
});
