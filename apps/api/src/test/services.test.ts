// Phase 5b acceptance — one key, three faces + per-model limits:
//  · the operator adds provider keys and does NOT type limits — the API
//    applies self-protecting defaults per category
//  · a customer's ONE gateway key calls text (alias), search, and image
//  · the operator's limits apply PER MODEL, pooled across the account
//  · the customer never sees a provider name, anywhere
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
      const u = req.url ?? '';
      if (u.includes('/image/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Buffer.from('FAKE-JPEG-BYTES'));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body || '{}') as { stream?: boolean };
        if (u.endsWith('/search')) {
          // both search rungs call /search — the header is the only tell
          // (tavily authenticates with Bearer, serper with x-api-key)
          res.writeHead(200, { 'content-type': 'application/json' });
          if (req.headers['x-api-key']) {
            res.end(JSON.stringify({ organic: [{ title: 'Serp', link: 'https://example.com/3', snippet: 'upstream organic content' }] }));
            return;
          }
          res.end(
            JSON.stringify({
              results: [
                { title: 'First', url: 'https://example.com/1', content: 'upstream content one' },
                { title: 'Second', url: 'https://example.com/2', content: 'upstream content two' },
              ],
            }),
          );
          return;
        }
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"t1","model":"upstream-secret-model","choices":[{"delta":{"content":"ok"}}]}\n\n');
          res.write('data: {"id":"t1","model":"upstream-secret-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3}}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 't1',
            model: 'upstream-secret-model',
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { prompt_tokens: 3, completion_tokens: 3 },
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

test('Phase 5b: one key, three faces — auto limits, per-model limits, opacity', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await prisma.providerCredential.updateMany({ where: { label: { in: ['s5-tavily', 's5-serper', 's5-poll', 's5-groq'] } }, data: { status: 'dead' } });
    await app.close();
    await up.close();
  });

  // ── accounts ──────────────────────────────────────────────────────────
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
  const customer = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({ method: 'POST', url: `/api/admin/users/${customer!.id}/verify`, headers: { authorization: `Bearer ${opToken}` } });
  assert.equal(res.statusCode, 200);
  const custOrg = (await prisma.membership.findFirst({ where: { userId: customer!.id } }))!;

  // operator self — make sure the operator has an org (fresh installs)
  let opMembership = await prisma.membership.findFirst({ where: { userId: operator!.id } });
  if (!opMembership) {
    const opOrg = await prisma.org.create({ data: { name: operator!.username } });
    await prisma.membership.create({ data: { userId: operator!.id, orgId: opOrg.id, role: 'owner' } });
    opMembership = await prisma.membership.findFirst({ where: { userId: operator!.id } });
  }

  // ── 1 · operator adds pool keys — NO limits typed ─────────────────────
  for (const [label, provider, secret] of [
    ['s5-groq', 'groq', 'gsk-s5-groq'],
    ['s5-tavily', 'tavily', 'tvly-s5-tavily'],
    ['s5-serper', 'serper', 'serp-s5-serper'],
    ['s5-poll', 'pollinations', ''],
  ] as const) {
    res = await app.inject({
      method: 'POST',
      url: '/api/account/keys',
      headers: { authorization: `Bearer ${opToken}` },
      payload: { provider, label, secret: secret || undefined },
    });
    assert.equal(res.statusCode, 201, `${provider} key`);
  }
  // the API applied self-protecting defaults — the operator never typed them
  res = await app.inject({ method: 'GET', url: '/api/account/keys', headers: { authorization: `Bearer ${opToken}` } });
  const opKeys = res.json().keys as { label: string; provider: string; limits: { kind: string; limit: number | null }[] }[];
  const tavily = opKeys.find((k) => k.label === 's5-tavily')!;
  const tavilyKinds = Object.fromEntries(tavily.limits.map((l) => [l.kind, l.limit]));
  assert.equal(tavilyKinds.rpm, 30, 'search keys get auto rpm');
  assert.equal(tavilyKinds.rpd, 5000, 'search keys get auto rpd');
  const groqKey = opKeys.find((k) => k.label === 's5-groq')!;
  const groqKinds = Object.fromEntries(groqKey.limits.map((l) => [l.kind, l.limit]));
  assert.equal(groqKinds.rpm, 60, 'text keys get auto rpm');
  assert.equal(groqKinds.tpm, 500000, 'text keys get auto tpm');

  // ── 2 · operator assigns the customer's model + per-model limits ──────
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/aliases`,
    headers: { authorization: `Bearer ${opToken}` },
    payload: { alias: 'fast', targets: [{ provider: 'groq', providerModelId: 'any-model' }] },
  });
  assert.equal(res.statusCode, 200);
  // per-model: 2 searches/min and 1 chat/min on 'fast' for this account
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/limits`,
    headers: { authorization: `Bearer ${opToken}` },
    payload: {
      limits: [
        { model: 'search', kind: 'rpm', limit: 2, reservePct: 0 },
        { model: 'fast', kind: 'rpm', limit: 1, reservePct: 0 },
        { model: 'image', kind: 'rpd', limit: 5, reservePct: 0 },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'GET', url: `/api/admin/users/${customer!.id}/limits`, headers: { authorization: `Bearer ${opToken}` } });
  const matrix = res.json();
  assert.ok((matrix.scopes as string[]).includes('fast'), 'the alias is a scope in the limit matrix');
  assert.ok(matrix.limits.some((l: { model: string | null; kind: string; limit: number | null }) => l.model === 'search' && l.kind === 'rpm' && l.limit === 2));

  // ── 3 · the customer issues ONE key ───────────────────────────────────
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const custToken: string = login.json().token;
  res = await app.inject({ method: 'POST', url: '/api/flow/keys', headers: { authorization: `Bearer ${custToken}` }, payload: { name: 'all-in-one' } });
  assert.equal(res.statusCode, 201);
  const gk: string = res.json().key;

  // fresh minute — the rpm windows must not straddle a boundary
  const guard = new Date().getUTCSeconds();
  if (guard > 55) await new Promise((r) => setTimeout(r, (60 - guard + 1) * 1000));

  // ── 4 · text through the alias (per-model 'fast' rpm=1) ───────────────
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().model, 'fast');
  assert.ok(!res.body.includes('groq'), 'no provider in the text response');
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${gk}` },
    payload: { model: 'fast', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 429, 'the second chat in the minute hits the per-model limit');
  assert.match(res.json().error, /fast/);
  assert.ok(!res.body.includes('groq'), 'the 429 must not name a provider');

  // ── 5 · search through the SAME key (per-model 'search' rpm=2) ────────
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/search',
    headers: { authorization: `Bearer ${gk}` },
    payload: { query: 'postgres pooler' },
  });
  assert.equal(res.statusCode, 200, `search1 dbg: ${res.statusCode} ${res.body.slice(0, 200)}`);
  const search1 = res.json();
  assert.ok(Array.isArray(search1.results) && search1.results.length === 2);
  assert.equal(search1.results[0].title, 'First');
  assert.ok(!res.body.includes('tavily'), 'no provider in the search response');
  assert.ok(!res.body.includes('serper'));

  res = await app.inject({ method: 'POST', url: '/api/flow/search', headers: { authorization: `Bearer ${gk}` }, payload: { query: 'again' } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'POST', url: '/api/flow/search', headers: { authorization: `Bearer ${gk}` }, payload: { query: 'third' } });
  assert.equal(res.statusCode, 429, 'the third search in the minute hits the per-model limit');
  assert.match(res.json().error, /search/);
  assert.ok(!res.body.includes('tavily') && !res.body.includes('serper'), 'the search 429 must not name a provider');

  // ── 6 · image through the SAME key ────────────────────────────────────
  res = await app.inject({ method: 'POST', url: '/api/flow/image', headers: { authorization: `Bearer ${gk}` }, payload: { prompt: 'a lighthouse at dawn' } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /image\/jpeg/);
  assert.equal(res.rawPayload.toString(), 'FAKE-JPEG-BYTES');

  // the chat limit did not leak into search, and vice versa — per-model
  const searchRows = await prisma.request.findMany({ where: { orgId: custOrg.orgId, category: 'search' } });
  assert.equal(searchRows.length, 2); // the 429 refused before a row
  assert.ok(searchRows.every((r) => r.modelServed === 'tavily'), 'both served by the first rung');
  const imageRows = await prisma.request.findMany({ where: { orgId: custOrg.orgId, category: 'image' } });
  assert.equal(imageRows.length, 1);
  const chatRows = await prisma.request.findMany({ where: { orgId: custOrg.orgId, category: 'text' } });
  assert.equal(chatRows.length, 1);
  // every face, one account, pooled into the operator's limits
  assert.ok((await prisma.request.count({ where: { orgId: custOrg.orgId } })) === 4);

  // ── 7 · the customer's view of all of it stays opaque ─────────────────
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${gk}` } });
  assert.equal(res.statusCode, 200);
  assert.ok(!res.body.includes('tavily') && !res.body.includes('serper') && !res.body.includes('pollinations') && !res.body.includes('groq'));
  assert.ok(!res.body.includes('upstream-secret-model'));
});
