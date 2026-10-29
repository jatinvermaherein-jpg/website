// Phase 11 acceptance — multi-project: two projects isolated; a pass in
// one cannot satisfy the other; the portfolio names the next human
// decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import type { Response } from 'light-my-request';

loadDotEnv();

async function verifiedUser(app: { inject: (r: unknown) => Promise<Response> }, name: string): Promise<{ token: string; org: { orgId: string }; user: { id: string } }> {
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, password: 'password123' } });
  assert.equal(res.statusCode, 201);
  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const opToken: string = opLogin.json().token;
  const target = await prisma.user.findUnique({ where: { username: name } });
  res = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${target!.id}/verify`,
    headers: { authorization: `Bearer ${opToken}` },
  });
  assert.equal(res.statusCode, 200);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: name, password: 'password123' } });
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  return { token: login.json().token, org, user: target! };
}

test('Phase 11: multi-project isolation + portfolio names the next decision', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const a = await verifiedUser(app, `p11a${Date.now().toString(36)}`);
  const H = { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' };
  const post = (url: string, payload: object, headers = H): Promise<Response> => app.inject({ method: 'POST', url, headers, payload });
  const get = (url: string, headers = H): Promise<Response> => app.inject({ method: 'GET', url, headers });

  const mk = Date.now().toString(36);
  const alpha = await prisma.project.create({ data: { orgId: a.org.orgId, slug: `al${mk}`, name: 'Alpha', status: 'active' } });
  const beta = await prisma.project.create({ data: { orgId: a.org.orgId, slug: `be${mk}`, name: 'Beta', status: 'active' } });

  // ── alpha: row J-01 goes to a WITNESSED pass ───────────────────────────
  let res = await post(`/api/projects/${alpha.slug}/rows`, { rowId: 'J-01', requirement: 'alpha requirement' });
  assert.equal(res.statusCode, 201);
  res = await post(`/api/projects/${alpha.slug}/stream`, {
    type: 'verdict',
    body: {
      rowId: 'J-01',
      seat: 'auditor',
      direction: 'falsify',
      environment: 'local-stack',
      verdict: 'pass',
      evidence: [{ kind: 'system-probe', ref: 'p' }],
      falsification: { command: 'true', output_digest: 'sha256:a' },
      instrumentControl: { command: 'test 1 = 2', output_digest: 'sha256:b', expected_failure: true, failedAsExpected: true },
      attestedNotWitnessed: false,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'pass');

  res = await get(`/api/projects/${alpha.slug}/rows`);
  const alphaRows = res.json().rows;
  assert.equal(alphaRows[0].resolved, 'pass', 'alpha J-01 is a witnessed pass');

  // ── beta: the SAME row id — alpha's pass must not carry over ───────────
  res = await post(`/api/projects/${beta.slug}/rows`, { rowId: 'J-01', requirement: 'beta requirement' });
  assert.equal(res.statusCode, 201);
  res = await get(`/api/projects/${beta.slug}/rows`);
  const betaRows = res.json().rows;
  assert.equal(betaRows[0].rowId, 'J-01');
  assert.equal(betaRows[0].resolved, 'unverified', 'a pass in one project cannot satisfy the other');
  assert.equal(betaRows[0].verdicts.length, 0, "alpha's verdicts do not leak into beta's board");
  assert.equal(betaRows[0].requirement, 'beta requirement');

  // ── org isolation: another org cannot even see these projects ──────────
  const b = await verifiedUser(app, `p11b${Date.now().toString(36)}`);
  const HB = { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' };
  res = await get(`/api/projects/${alpha.slug}/rows`, HB);
  assert.equal(res.statusCode, 404, 'org B cannot read org A\'s project stream');
  res = await get(`/api/projects/${alpha.slug}/stream?afterSeq=0`, HB);
  assert.equal(res.statusCode, 404);
  res = await post(`/api/projects/${alpha.slug}/rows`, { rowId: 'J-99' }, HB);
  assert.equal(res.statusCode, 404, 'org B cannot post into org A\'s spine');

  // ── the portfolio names the next human decision ────────────────────────
  // beta has an un-witnessed claim now
  res = await post(`/api/projects/${beta.slug}/stream`, {
    type: 'verdict',
    body: {
      rowId: 'J-01',
      seat: 'builder',
      direction: 'assert',
      environment: 'local-stack',
      verdict: 'pass',
      evidence: [{ kind: 'repo', ref: 'src/x.ts' }],
    },
  });
  assert.equal(res.json().verdict, 'unproven', 'the claim is demoted at post');

  res = await get('/api/portfolio');
  assert.equal(res.statusCode, 200);
  const pf = res.json();
  const alphaP = pf.projects.find((p: { slug: string }) => p.slug === alpha.slug);
  const betaP = pf.projects.find((p: { slug: string }) => p.slug === beta.slug);
  assert.ok(alphaP && betaP, 'both projects are in the org portfolio');
  assert.equal(alphaP.nextDecision.kind, 'ship', 'all-green alpha asks for the ship decision');
  assert.equal(betaP.nextDecision.kind, 'witness', "beta's un-witnessed claim asks for an auditor");
  assert.match(betaP.nextDecision.prompt, /J-01/);
  assert.deepEqual(betaP.nextDecision.options, ['witness', 'reject']);
  assert.ok(pf.nextDecision, 'the org-level next decision names a project');
  assert.equal(pf.nextDecision.project, beta.slug, 'the open work (beta) outranks the green project');
});
