// 0006 + pool reconciliation + usage series:
//  · the gateway checks the providers' model catalogs daily (a pool key's
//    catalog is fetched at most once per 20h) and records sightings
//  · a customer sees the model names they may call, with a "verified"
//    badge — never the provider behind them
//  · a per-model grant can never exceed the pool's real capacity for that
//    model — it is clamped to a usage-based fraction (30-80%) of the pool
//  · /usage carries a 30-day daily series for the dashboard charts
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { refreshCatalogForCredential, catalogStatusForTargets, providerCatalog } from '../lib/catalog.js';

loadDotEnv();

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url ?? '';
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (u.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'llama-x' }, { id: 'llama-y' }] }));
          return;
        }
        let j: { stream?: boolean };
        try {
          j = JSON.parse(body || '{}');
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"bad request"}');
          return;
        }
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: {"id":"t1","choices":[{"delta":{"content":"ok"}}]}\n\n');
          res.write('data: {"id":"t1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3}}\n\n');
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

test('0006: daily catalogs, verified model names, pool-capped grants, usage series', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  let opMembership = await prisma.membership.findFirst({ where: { userId: operator!.id } });
  if (!opMembership) {
    const opOrg = await prisma.org.create({ data: { name: operator!.username } });
    await prisma.membership.create({ data: { userId: operator!.id, orgId: opOrg.id, role: 'owner' } });
    opMembership = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;
  }
  const opOrgId = opMembership.orgId;

  // the operator org is shared across tests — start from a known pool
  await prisma.providerCredential.updateMany({ where: { orgId: opOrgId, status: 'active' }, data: { status: 'dead' } });
  // earlier runs of this test granted 'llama-x' on since-gone orgs — those
  // grants count as "elsewhere" and would eat the headroom this run asserts
  await prisma.orgLimit.deleteMany({ where: { model: 'llama-x' } });

  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await prisma.providerCredential.updateMany({ where: { orgId: opOrgId, label: { in: ['c6-groq', 'c6-tavily'] } }, data: { status: 'dead' } });
    await app.close();
    await up.close();
  });

  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const OH = { authorization: `Bearer ${opToken}` };

  // ── customer ──────────────────────────────────────────────────────────
  const username = `c6${Date.now().toString(36)}`;
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  const customer = await prisma.user.findUnique({ where: { username } });
  res = await app.inject({ method: 'POST', url: `/api/admin/users/${customer!.id}/verify`, headers: OH });
  assert.equal(res.statusCode, 200);
  const custOrg = (await prisma.membership.findFirst({ where: { userId: customer!.id } }))!;

  // ── the pool: one groq key (auto limits) + one tavily key ─────────────
  res = await app.inject({ method: 'POST', url: '/api/account/keys', headers: OH, payload: { provider: 'groq', label: 'c6-groq', secret: 'gsk-c6-groq' } });
  assert.equal(res.statusCode, 201);
  const groqKeyId: string = res.json().id;
  res = await app.inject({ method: 'POST', url: '/api/account/keys', headers: OH, payload: { provider: 'tavily', label: 'c6-tavily', secret: 'tvly-c6' } });
  assert.equal(res.statusCode, 201);

  // ── 1 · the daily catalog check ───────────────────────────────────────
  const cred = await prisma.providerCredential.findUniqueOrThrow({ where: { id: groqKeyId } });
  const seen = await refreshCatalogForCredential(prisma, { id: cred.id, provider: cred.provider, secretStored: cred.secretStored });
  assert.deepEqual(seen.sort(), ['llama-x', 'llama-y']);
  const after = await prisma.providerCredential.findUniqueOrThrow({ where: { id: groqKeyId } });
  assert.ok(after.lastCatalogCheckedAt, 'the key is stamped as checked');

  const cat = await providerCatalog(prisma, 'groq');
  assert.ok(cat.models.some((m) => m.model === 'llama-x'));

  // a model still in the fresh catalog → live; a retired one → missing
  const live = await catalogStatusForTargets(prisma, [{ provider: 'groq', providerModelId: 'llama-x' }]);
  assert.equal(live.status, 'live');
  const dead = await catalogStatusForTargets(prisma, [{ provider: 'groq', providerModelId: 'retired-model' }]);
  assert.equal(dead.status, 'partial');
  assert.deepEqual(dead.missing, ['retired-model']);

  // ── 2 · the operator catalog desk ─────────────────────────────────────
  res = await app.inject({ method: 'GET', url: '/api/admin/catalog', headers: OH });
  assert.equal(res.statusCode, 200);
  const desk = res.json();
  const groqDesk = desk.catalog.find((c: { provider: string }) => c.provider === 'groq');
  assert.equal(groqDesk.hasPoolKey, true);
  assert.equal(groqDesk.fresh, true);
  assert.ok(groqDesk.models.some((m: { model: string }) => m.model === 'llama-x'));
  res = await app.inject({ method: 'POST', url: '/api/admin/catalog/refresh', headers: OH });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().refreshed.some((r: { provider: string; ok: boolean }) => r.provider === 'groq' && r.ok));

  // ── 3 · two aliases: one whose model is live, one retired ─────────────
  res = await app.inject({ method: 'PUT', url: `/api/admin/users/${customer!.id}/aliases`, headers: OH, payload: { alias: 'llama-x', targets: [{ provider: 'groq', providerModelId: 'llama-x' }] } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'PUT', url: `/api/admin/users/${customer!.id}/aliases`, headers: OH, payload: { alias: 'old-model', targets: [{ provider: 'groq', providerModelId: 'retired-model' }] } });
  assert.equal(res.statusCode, 200);

  // the operator's view shows the catalog health per alias
  res = await app.inject({ method: 'GET', url: `/api/admin/users/${customer!.id}/aliases`, headers: OH });
  const aliases = res.json().aliases as { alias: string; catalog: { status: string } }[];
  assert.equal(aliases.find((a) => a.alias === 'llama-x')!.catalog.status, 'live');
  assert.equal(aliases.find((a) => a.alias === 'old-model')!.catalog.status, 'partial');

  // the customer sees names + verification — never providers
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'password123' } });
  const custToken: string = login.json().token;
  res = await app.inject({ method: 'GET', url: '/api/account/aliases', headers: { authorization: `Bearer ${custToken}` } });
  assert.equal(res.statusCode, 200);
  const custAliases = res.json().aliases as { alias: string; verified: boolean }[];
  assert.equal(custAliases.find((a) => a.alias === 'llama-x')!.verified, true, 'live model is verified for the customer');
  assert.equal(custAliases.find((a) => a.alias === 'old-model')!.verified, false, 'retired model is not verified');
  assert.ok(!res.body.includes('groq'), 'the customer list never names a provider');
  const services = res.json().services as { name: string; available: boolean }[];
  assert.equal(services.find((s) => s.name === 'search')!.available, true, 'search face is live on the pool');

  // ── 4 · a grant can never outgrow the pool ────────────────────────────
  // pool = one groq key with auto rpm 60 → 'llama-x' pool capacity 60 rpm
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/limits`,
    headers: OH,
    payload: { limits: [{ model: 'llama-x', kind: 'rpm', limit: 1000, reservePct: 0 }] },
  });
  assert.equal(res.statusCode, 200);
  const put = res.json();
  assert.equal(put.limits.find((l: { model: string; kind: string }) => l.model === 'llama-x' && l.kind === 'rpm').limit, 48, 'clamped to 80% of the 60 rpm pool (new account)');
  const cap = put.caps.find((c: { model: string }) => c.model === 'llama-x');
  assert.ok(cap, 'the cap is reported');
  assert.equal(cap.poolCap, 60);
  assert.match(cap.note as string, /pool/);

  // the GET shows the pool matrix the editor renders next to the inputs
  res = await app.inject({ method: 'GET', url: `/api/admin/users/${customer!.id}/limits`, headers: OH });
  const matrix = res.json();
  assert.equal(matrix.pool['llama-x'].rpm.cap, 60);
  assert.equal(matrix.pool['llama-x'].rpm.elsewhere, 0);
  assert.equal(matrix.fraction, 0.8, 'a fresh account may hold 80% of the pool');

  // a sensible grant inside the pool passes through untouched
  res = await app.inject({
    method: 'PUT',
    url: `/api/admin/users/${customer!.id}/limits`,
    headers: OH,
    payload: { limits: [{ model: 'llama-x', kind: 'rpm', limit: 30, reservePct: 0 }] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().caps.length, 0, 'a grant within the pool is not touched');
  assert.equal(res.json().limits.find((l: { model: string; kind: string }) => l.model === 'llama-x' && l.kind === 'rpm').limit, 30);

  // ── 5 · traffic on the verified model + the usage series ──────────────
  res = await app.inject({ method: 'POST', url: '/api/flow/keys', headers: { authorization: `Bearer ${custToken}` }, payload: { name: 'chart-key' } });
  assert.equal(res.statusCode, 201);
  const gk: string = res.json().key;
  const guard = new Date().getUTCSeconds();
  if (guard > 55) await new Promise((r) => setTimeout(r, (60 - guard + 1) * 1000));

  res = await app.inject({ method: 'POST', url: '/api/flow/chat/completions', headers: { authorization: `Bearer ${gk}` }, payload: { model: 'llama-x', messages: [{ role: 'user', content: 'hi' }], stream: false } });
  assert.equal(res.statusCode, 200);

  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${gk}` } });
  assert.equal(res.statusCode, 200);
  const usage = res.json();
  assert.equal(usage.series.days.length, 30);
  const today = usage.series.days[29];
  assert.ok(today.requests >= 1, 'today has the chat request');
  assert.ok(today.tokens >= 6, 'tokens are summed in');
  assert.ok(usage.series.models.some((m: { model: string }) => m.model === 'llama-x'));
  assert.ok(!res.body.includes('groq'), 'the series never names a provider');
  assert.ok(!res.body.includes('upstream-secret-model'));

  // the account's requests for today exist for the chart
  const rows = await prisma.request.findMany({ where: { orgId: custOrg.orgId, category: 'text' } });
  assert.equal(rows.length, 1);
});
