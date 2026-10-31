// Phase 5 acceptance — the resale contract:
//  user registers → operator verifies → operator sets the account's limits
//  → the customer issues their own gateway keys → every key pools into the
//  operator's numbers → the customer never sees a provider name anywhere
//  (errors, responses, headers, or the usage view).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

loadDotEnv();

const SECRET = 'gsk-test-operator-pool-key';

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body) as { stream?: boolean };
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"s1","model":"upstream-secret-model","choices":[{"delta":{"content":"ok"}}]}\n\n');
          res.write('data: {"id":"s1","model":"upstream-secret-model","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 's1',
              model: 'upstream-secret-model',
              choices: [{ message: { role: 'assistant', content: 'ok' } }],
              usage: { prompt_tokens: 7, completion_tokens: 9 },
            }),
          );
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

test('Phase 5: account resale — verify, operator limits, pooled keys, opacity', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    // retire the shared-pool key so other tests' operator-org assumptions
    // (no active groq key) stay true under any execution order
    await prisma.providerCredential.updateMany({ where: { label: 'p5-shared' }, data: { status: 'dead' } });
    await app.close();
    await up.close();
  });

  // ── 1. customer registers, operator verifies ─────────────────────────
  const username = `c${Date.now().toString(36)}`;
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const customer = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${customer!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const custToken: string = login.json().token;
  const custOrg = (await prisma.membership.findFirst({ where: { userId: customer!.id } }))!;

  // the operator's shared pool: one groq key on the OPERATOR org
  let opMembership = await prisma.membership.findFirst({ where: { userId: operator!.id } });
  if (!opMembership) {
    const opOrg = await prisma.org.create({ data: { name: operator!.username } });
    await prisma.membership.create({ data: { userId: operator!.id, orgId: opOrg.id, role: 'owner' } });
    opMembership = opOrg.id ? await prisma.membership.findFirst({ where: { userId: operator!.id } }) : null;
  }
  res = await app.inject({
    method: 'POST',
    url: '/api/account/keys',
    headers: { authorization: `Bearer ${opToken}` },
    payload: { provider: 'groq', label: 'p5-shared', secret: SECRET },
  });
  assert.equal(res.statusCode, 201);
  const sharedKeyId: string = res.json().id;

  // ── 2. operator assigns the customer's model names + account limits ──
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/aliases`,
    headers: { authorization: `Bearer ${opToken}` },
    payload: { alias: 'fast', targets: [{ provider: 'groq', providerModelId: 'any-model' }] },
  });
  assert.equal(res.statusCode, 200);
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/limits`,
    headers: { authorization: `Bearer ${opToken}` },
    payload: { limits: [{ kind: 'rpm', limit: 2, reservePct: 0 }] },
  });
  assert.equal(res.statusCode, 200);

  // (alias self-service stays open to members for their own BYO keys; the
  // opacity contract is about what ANSWERS a customer call, not who writes
  // the reference)

  // ── 3. the customer issues their own gateway key ─────────────────────
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/keys',
    headers: { authorization: `Bearer ${custToken}` },
    payload: { name: 'app-key' },
  });
  assert.equal(res.statusCode, 201);
  const gk: string = res.json().key;
  assert.ok(gk.startsWith('jkn_'));

  // ── 4. the customer calls through the alias — served from the pool ───
  // fresh minute: the rpm window must not straddle a boundary mid-burst
  const guard = new Date().getUTCSeconds();
  if (guard > 55) await new Promise((r) => setTimeout(r, (60 - guard + 1) * 1000));

  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 200);
  const body1: Record<string, unknown> = res.json();
  assert.equal(body1.model, 'fast'); // the upstream model id never reaches the customer
  assert.ok(!res.body.includes('upstream-secret-model'));
  assert.ok(!res.body.includes('groq'), 'provider name must not appear in the customer response');

  // streaming: every data payload carries the customer's own model name
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('"model":"fast"'));
  assert.ok(!res.body.includes('upstream-secret-model'), 'stream must not leak the upstream model');
  assert.ok(!res.body.includes('groq'), 'stream must not leak the provider');

  // ── 5. the third call in the minute hits the operator's limit ────────
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 429);
  assert.ok(/usage limit reached/.test(res.json().error));
  assert.ok(!res.body.includes('groq'), 'the 429 must not name a provider');

  // direct provider/model references are an operator capability
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'groq/any-model', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(!res.body.includes('openrouter'), 'the error must not list our providers');

  // unknown model → opaque
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'does-not-exist', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 400);
  assert.ok(!res.body.includes('alias'));

  // ── 6. the customer's own usage view is scoped ───────────────────────
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${gk}` } });
  assert.equal(res.statusCode, 200);
  const usage: Record<string, unknown> = res.json();
  assert.ok(Array.isArray(usage.gatewayKeys));
  assert.ok(Array.isArray(usage.orgWindows));
  // the ledger may ride the key view, but only redacted: a resale account
  // owns no provider keys, so `keys` must be empty and no row may name the
  // pool's credential or the upstream model
  assert.ok(Array.isArray(usage.keys) && (usage.keys as unknown[]).length === 0, 'the shared pool must not be listed to the customer');
  assert.ok(!res.body.includes('groq'), 'the key usage view must not name a provider');
  assert.ok(!res.body.includes('upstream-secret-model'));

  // the member's own aliases view is names only
  res = await app.inject({ method: 'GET', url: '/api/account/aliases', headers: { authorization: `Bearer ${custToken}` } });
  assert.equal(res.statusCode, 200);
  const aliases = res.json().aliases as { alias: string; targets?: unknown }[];
  assert.equal(aliases[0]?.alias, 'fast');
  assert.ok(!('targets' in (aliases[0] ?? {})), 'members see model names, not targets');
  assert.ok(!res.body.includes('groq'));

  // ── 7. suspension kills the account's keys instantly ─────────────────
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${customer!.id}/suspend`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200);
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'account suspended');

  // the ledger attributed everything to the CUSTOMER org, served by the
  // operator's credential — the pooling, verifiable in the rows
  const rows = await prisma.request.findMany({ where: { orgId: custOrg.orgId }, orderBy: { createdAt: 'asc' } });
  // exactly the two served calls write rows — the 429/400/403 are refused
  // before a row exists
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.orgId === custOrg.orgId));
  assert.ok(rows.filter((r) => r.status === 'ok').every((r) => r.credentialId === sharedKeyId));
});
