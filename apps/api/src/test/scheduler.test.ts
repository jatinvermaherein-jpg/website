// Phase 3 acceptance — the quota scheduler, proven with numbers:
//   key A: rpm = 1  (resets within the minute)
//   key B: rpd = 3  (resets at day's end)
// B holds 3× the headroom, yet A must be spent FIRST — its quota dies soon.
// A:1 + B:3 requests succeed; the next one is a structured 429 naming the
// exhausted window and a retry_after. All counts come from the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { keyWindows, urgency } from '../lib/quota.js';

loadDotEnv();

function fakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c3',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
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

test('Phase 3: soonest-reset-first — the small window is spent before the big one', async (t) => {
  const up = await fakeUpstream();
  process.env.JATIN_UPSTREAM_BASE = up.url;
  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    delete process.env.JATIN_UPSTREAM_BASE;
    await app.close();
    await up.close();
  });

  // keep the whole burst inside one minute (window arithmetic stays stable)
  const guard = new Date().getUTCSeconds();
  if (guard > 55) await new Promise((r) => setTimeout(r, (60 - guard + 1) * 1000));

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

  const postKey = (label: string, limits: { kind: string; limit: number; reservePct: number }[]) =>
    app.inject({
      method: 'POST',
      url: '/api/account/keys',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'groq', label, secret: 'gsk-sched-' + label, limits },
    });
  res = await postKey('minute', [{ kind: 'rpm', limit: 1, reservePct: 0 }]);
  assert.equal(res.statusCode, 201);
  res = await postKey('day', [{ kind: 'rpd', limit: 3, reservePct: 0 }]);
  assert.equal(res.statusCode, 201);
  const keyA = await prisma.providerCredential.findFirst({ where: { orgId: org.orgId, label: 'minute' } });
  const keyB = await prisma.providerCredential.findFirst({ where: { orgId: org.orgId, label: 'day' } });

  // the numbers, before a single request — logged so a stranger can audit
  const wA = await keyWindows(prisma, keyA!.id);
  const wB = await keyWindows(prisma, keyB!.id);
  const uA = urgency(wA);
  const uB = urgency(wB);
  console.log(
    `  scheduler numbers → A(rpm 1): urgency ${uA.toFixed(5)} t/ms · B(rpd 3): urgency ${uB.toFixed(5)} t/ms · first pick: ${uA > uB ? 'A (sooner reset)' : 'B'}`,
  );
  assert.ok(uA > uB, 'the minute-window key must outrank the day-window key');

  const servedBy: string[] = [];
  for (let i = 1; i <= 4; i++) {
    res = await app.inject({
      method: 'POST',
      url: '/api/flow/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'groq/any', messages: [{ role: 'user', content: 'hi' }], stream: false },
    });
    assert.equal(res.statusCode, 200, `request ${i} should be served`);
    const row = await prisma.request.findFirst({ where: { orgId: org.orgId }, orderBy: { createdAt: 'desc' } });
    servedBy.push(row!.credentialId!);
    assert.equal(res.json().usage.prompt_tokens, 10); // real counts, relayed
  }

  // A carried exactly 1 (its rpm), B the remaining 3 (its rpd)
  assert.equal(servedBy.filter((id) => id === keyA!.id).length, 1, 'the soonest-reset key is spent first, then exhausted');
  assert.equal(servedBy.filter((id) => id === keyB!.id).length, 3);
  assert.equal(servedBy[0], keyA!.id);

  // the fifth request: structured refusal with the wall, not a wall of silence
  res = await app.inject({
    method: 'POST',
    url: '/api/flow/chat/completions',
    headers: { authorization: `Bearer ${token}` },
    payload: { model: 'groq/any', messages: [{ role: 'user', content: 'hi' }], stream: false },
  });
  assert.equal(res.statusCode, 429);
  // the customer-facing 429 is opaque (no provider names); operators get the
  // detailed wall. The retry hint is the contract for both.
  assert.match(res.json().error, /usage limit reached|quota limit/);
  assert.ok(!res.body.includes('openrouter'));
  assert.ok(Number(res.json().retry_after_s) >= 1);

  // the dashboard numbers: measured headroom, zero on A's minute window
  res = await app.inject({ method: 'GET', url: '/api/flow/usage', headers: { authorization: `Bearer ${token}` } });
  const usage = res.json();
  const aView = usage.keys.find((k: { id: string }) => k.id === keyA!.id);
  assert.equal(aView.windows[0].kind, 'rpm');
  assert.equal(aView.windows[0].used, 1);
  assert.equal(aView.windows[0].headroom, 0);
});
