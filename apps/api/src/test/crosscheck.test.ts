// Phase 8 acceptance — the auditor on a DIFFERENT provider catches the
// planted bug the builder missed. The builder's claim is an attestation;
// the witness RUNS the falsification (+ instrument control) and the row
// resolves by cross-check. A control that fails to fail poisons its verdict
// (unproven).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { REPO_ROOT } from '../lib/paths.js';
import type { Response } from 'light-my-request';

loadDotEnv();

test('Phase 8: cross-check — different-provider auditor catches the planted bug', async (t) => {
  const app = await buildApp();
  await app.ready();

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
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const org = (await prisma.membership.findFirst({ where: { userId: target!.id } }))!;
  const slug = `x${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'X8', status: 'active' } });
  const workdir = `${REPO_ROOT}/workspace/${slug}`;
  t.after(async () => {
    rmSync(workdir, { recursive: true, force: true });
    await app.close();
  });

  const post = (url: string, payload: object): Promise<Response> =>
    app.inject({ method: 'POST', url, headers: H, payload });
  const get = (url: string): Promise<Response> => app.inject({ method: 'GET', url, headers: H });

  // ── BUILDER (provider: groq) — writes the artifact with a planted bug ──
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    `${workdir}/sum.js`,
    `// sum — builder's claim: "done, works"\n` +
      `function sum(a){ let t=0; for(let i=0;i<a.length-1;i++) t+=a[i]; return t; }\n` + // ← off-by-one: drops the last element
      `module.exports = { sum };\n`,
  );

  res = await post(`/api/projects/${slug}/rows`, { rowId: 'J-01', requirement: 'sum([1,2,3]) === 6', bySeat: 'builder-groq' });
  assert.equal(res.statusCode, 201);

  // the builder CLAIMS pass — attested, never ran the falsification
  res = await post(`/api/projects/${slug}/stream`, {
    type: 'verdict',
    body: {
      rowId: 'J-01',
      seat: 'builder-groq',
      direction: 'assert',
      environment: 'local-stack',
      verdict: 'pass',
      evidence: [{ kind: 'repo', ref: 'sum.js', provider: 'groq' }],
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'unproven', 'a claim without a falsification attempt is unproven');

  // the board: an attestation cannot close the row
  res = await get(`/api/projects/${slug}/rows`);
  let j01 = res.json().rows.find((r: { rowId: string }) => r.rowId === 'J-01');
  assert.equal(j01.resolved, 'unverified');
  assert.equal(j01.builderClaim, "claimed (attested)");

  // ── AUDITOR (provider: openrouter) — RUNS the falsification ────────────
  const command =
    `node -e "const {sum}=require('./sum.js'); const got=sum([1,2,3]); ` +
    `if(got!==6){console.error('BUG: sum([1,2,3])='+got+' expected 6');process.exit(1)} console.log('ok')"`;
  const controlCommand = `test 1 = 2`; // an instrument that must fail (and does)

  res = await post(`/api/projects/${slug}/falsify`, {
    rowId: 'J-01',
    seat: 'auditor-openrouter',
    command,
    control: { command: controlCommand, expected_failure: true },
  });
  assert.equal(res.statusCode, 200);
  const run = res.json();
  assert.equal(run.falsification.passed, false, 'the falsification RAN and the bug showed');
  assert.match(run.falsification.tail, /BUG: sum\(\[1,2,3\]\)=3/);
  assert.ok(run.falsification.output_digest.startsWith('sha256:'));
  assert.equal(run.instrumentControl.failedAsExpected, true, 'the control failed as expected — the instrument is trustworthy');

  // the auditor posts the WITNESSED verdict (different provider than the builder)
  res = await post(`/api/projects/${slug}/stream`, {
    type: 'verdict',
    body: {
      rowId: 'J-01',
      seat: 'auditor-openrouter',
      direction: 'falsify',
      environment: 'local-stack',
      verdict: 'fail',
      evidence: [{ kind: 'system-probe', ref: 'sum.js', provider: 'openrouter' }],
      falsification: { command, output_digest: run.falsification.output_digest },
      instrumentControl: {
        command: controlCommand,
        output_digest: run.instrumentControl.output_digest,
        expected_failure: true,
        failedAsExpected: true,
      },
      attestedNotWitnessed: false,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().verdict, 'fail', 'falsification + control in place — the fail stands');

  // ── THE CROSS-CHECK: the row resolves FAIL, witnessed by the other provider ─
  res = await get(`/api/projects/${slug}/rows`);
  j01 = res.json().rows.find((r: { rowId: string }) => r.rowId === 'J-01');
  assert.equal(j01.resolved, 'fail', 'the planted bug is caught — the row fails');
  assert.equal(j01.witnessedBy, 'auditor-openrouter');
  assert.equal(j01.builderClaim, "claimed (attested)", 'the builder\'s claim stays on the record');
  assert.equal(j01.verdicts.length, 2);
  const providers = j01.verdicts.map((v: { seat: string }) => v.seat.split('-')[1]);
  assert.notEqual(new Set(providers).size, 1, 'builder and auditor sat on different providers');

  // ── a control that FAILS TO FAIL poisons its own verdict ───────────────
  await post(`/api/projects/${slug}/rows`, { rowId: 'J-02', requirement: 'untrusted probe', bySeat: 'builder-groq' });
  res = await post(`/api/projects/${slug}/stream`, {
    type: 'verdict',
    body: { rowId: 'J-02', seat: 'builder-groq', direction: 'assert', environment: 'local-stack', verdict: 'pass', evidence: [{ kind: 'repo', ref: 'x' }] },
  });
  assert.equal(res.json().verdict, 'unproven');

  res = await post(`/api/projects/${slug}/falsify`, {
    rowId: 'J-02',
    seat: 'auditor-openrouter',
    command: 'true',
    control: { command: 'true', expected_failure: true }, // "must fail" — but it exits 0
  });
  const bad = res.json();
  assert.equal(bad.instrumentControl.failedAsExpected, false);
  assert.match(bad.note ?? '', /unproven/);

  res = await post(`/api/projects/${slug}/stream`, {
    type: 'verdict',
    body: {
      rowId: 'J-02',
      seat: 'auditor-openrouter',
      direction: 'falsify',
      environment: 'local-stack',
      verdict: 'pass',
      evidence: [{ kind: 'system-probe', ref: 'x', provider: 'openrouter' }],
      falsification: { command: 'true', output_digest: bad.falsification.output_digest },
      instrumentControl: {
        command: 'true',
        output_digest: bad.instrumentControl.output_digest,
        expected_failure: true,
        failedAsExpected: false,
      },
      attestedNotWitnessed: false,
    },
  });
  assert.equal(res.statusCode, 201);

  res = await get(`/api/projects/${slug}/rows`);
  const j02 = res.json().rows.find((r: { rowId: string }) => r.rowId === 'J-02');
  assert.equal(j02.resolved, 'unproven', 'a broken instrument cannot prove anything');
});
