// The work loop, governance, and the one seq authority.
//
// The concurrency test at the top is the important one: before lib/append.ts
// there were two call sites that read the max seq in a transaction that had
// already committed, then inserted outside it, wrapped in .catch(() => {}).
// Under load they silently dropped lines. This proves they cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDotEnv } from '../lib/env.js';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { appendEvent } from '../lib/append.js';

loadDotEnv();

test('one seq authority: 25 concurrent appends, 25 distinct lines, none dropped', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const org = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;
  const slug = `q${Date.now().toString(36)}`;
  const project = await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'Concurrency', status: 'active' } });

  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      appendEvent({ projectId: project.id, type: 'message', actor: `racer-${i}`, body: { text: `line ${i}` } }),
    ),
  );

  const rows = await prisma.event.findMany({ where: { scopeId: project.id }, orderBy: { seq: 'asc' } });
  assert.equal(rows.length, N, 'every append must land — a lost line is the one unforgivable bug');

  const seqs = rows.map((r) => r.seq.toString());
  assert.equal(new Set(seqs).size, N, 'no two lines may share a seq');
  for (let i = 0; i < N; i++) assert.equal(seqs[i], String(i + 1), 'the sequence must be gapless 1..N');

  const actors = new Set(rows.map((r) => r.actor));
  assert.equal(actors.size, N, 'every racer is represented');
});

test('work loop: create → claim → submit → witness, with separation of duties enforced', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const opLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! } });
  const asOp = { authorization: `Bearer ${opLogin.json().token}` };
  const org = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;

  const slug = `w${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'WorkLoop', status: 'active' } });

  const mk = async (name: string, role: string) => {
    const r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/seats`, headers: asOp, payload: { name, role } });
    return { id: r.json().seat.id as string, key: r.json().key as string };
  };
  const builder = await mk('builder-1', 'builder');
  const auditor = await mk('auditor-1', 'auditor');
  const H = (k: string) => ({ authorization: `Bearer ${k}` });

  const streamPost = (body: unknown, k: string) =>
    app.inject({ method: 'POST', url: `/api/projects/${slug}/stream`, headers: H(k), payload: body as never });

  // both admit
  for (const [k, who] of [[builder.key, 'builder-1'], [auditor.key, 'auditor-1']] as [string, string][]) {
    const r = await streamPost({ type: 'admission', body: { takes: `work as ${who}`, stale: 'nothing', doesNotUnderstand: 'little' } }, k);
    assert.equal(r.statusCode, 201);
  }

  // ── create ─────────────────────────────────────────────────────────────
  let r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks`, headers: asOp,
    payload: { title: 'harden the parser', acceptance: 'rejects malformed input', environment: 'staging' },
  });
  assert.equal(r.statusCode, 201);
  const taskId: string = r.json().id;
  assert.equal(r.json().status, 'backlog');
  assert.equal(r.json().environment, 'staging');

  // a builder may not put work on the board
  r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/tasks`, headers: H(builder.key), payload: { title: 'my own work' } });
  assert.equal(r.statusCode, 403, 'a builder cannot commit the team');

  // ── claim ──────────────────────────────────────────────────────────────
  r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/claim`, headers: H(builder.key) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().owner, 'builder-1');

  // a second claim loses — one task, one owner
  r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/claim`, headers: H(auditor.key) });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /one task, one owner/);

  // ── submit: owner only ─────────────────────────────────────────────────
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/submit`, headers: H(auditor.key),
    payload: { summary: 'I did it, honest' },
  });
  assert.equal(r.statusCode, 403, 'only the owner submits');

  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/submit`, headers: H(builder.key),
    payload: { summary: 'parser now rejects malformed input', artifacts: [{ commit: 'abc1234', path: 'src/parser.ts', contentHash: 'sha256:deadbeefdeadbeef' }] },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'review');

  // the artifact was actually recorded — Artifact was a dead table
  const art = await prisma.artifact.findMany({ where: { path: 'src/parser.ts' } });
  assert.ok(art.length >= 1, 'a submitted artifact must be recorded, not just mentioned');

  // ── witness: separation of duties, enforced ────────────────────────────
  // the builder cannot sign its own work off
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/witness`, headers: H(builder.key),
    payload: { verdict: 'pass', reason: 'looks great to me' },
  });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /witness your own work/);

  // a pass with no falsification attempt is recorded unproven and closes nothing
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/witness`, headers: H(auditor.key),
    payload: { verdict: 'pass', reason: 'read the diff, seems fine' },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().verdict, 'unproven', 'no falsification → unproven, by the envelope law');
  assert.equal(r.json().taskStatus, 'review', 'an unproven witness must not close the task');

  // ── the half-proof trap ────────────────────────────────────────────────
  // A pass with a falsification attempt but NO instrument control is still
  // not proof: the check was never shown capable of failing. The law demotes
  // it, so the task must stay open. This regressed once — the route closed
  // the task `done` while the stream said `unproven`, and the two disagreed.
  {
    const r = await app.inject({
      method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/witness`, headers: H(auditor.key),
      payload: {
        verdict: 'pass',
        reason: 'ran the malformed-input case, it rejects',
        falsification: { command: 'curl -d "{" ...', output_digest: 'sha256:aaaa' },
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().verdict, 'unproven', 'falsification without a control proves nothing');
    assert.equal(r.json().taskStatus, 'review', 'a demoted pass must not close the task');
    assert.deepEqual(r.json().demotedFor, ['no-instrument-control'], 'the response must name what was missing');
    const board = await app.inject({ method: 'GET', url: `/api/projects/${slug}/tasks`, headers: asOp });
    const t2 = board.json().tasks.find((x: { id: string }) => x.id === taskId);
    assert.equal(t2.status, 'review', 'the board agrees with the stream');
    const ledger = await app.inject({ method: 'GET', url: `/api/projects/${slug}/ledger`, headers: asOp });
    const taskRow = `T-${taskId.slice(-6).toUpperCase()}`;
    const row = ledger.json().rows.find((x: { rowId: string }) => x.rowId === taskRow);
    assert.ok(row, 'a witnessed task must appear in the ledger even with no registered row');
    assert.equal(row.status, 'unproven', 'and so does the ledger — one truth, three views');
    assert.equal(row.decidedBy, 'auditor-1');
    assert.equal(row.registered, false, 'and it says the row was never registered');
  }

  // a real witness attempt, with a control that failed as expected — this closes it
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/tasks/${taskId}/witness`, headers: H(auditor.key),
    payload: {
      verdict: 'pass',
      reason: 'fed it 200 malformed inputs; zero accepted; the instrument rejected a known-bad control',
      falsification: { command: 'node scripts/fuzz.mjs --malformed 200', output_digest: 'sha256:0f0f0f0f' },
      instrumentControl: { command: 'node scripts/fuzz.mjs --control', output_digest: 'sha256:1a1a1a1a', expected_failure: 'control must be rejected' },
    },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().verdict, 'pass');
  assert.equal(r.json().taskStatus, 'done');

  // ── governance ─────────────────────────────────────────────────────────
  // a crew cannot waive its own law
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/waivers`, headers: H(auditor.key),
    payload: { ruleId: 'J-09', reason: 'we are in a hurry this week', scope: 'parser', days: 7 },
  });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /does not have rules/);

  // the operator can, and it expires
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/waivers`, headers: asOp,
    payload: { ruleId: 'J-01', reason: 'legacy surface, scheduled for removal in Q1', scope: 'parser', days: 3 },
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().live, true);

  // a breach is a record any admitted seat can file
  r = await app.inject({
    method: 'POST', url: `/api/projects/${slug}/breaches`, headers: H(auditor.key),
    payload: { ruleId: 'J-09', artifactRef: 'src/legacy.ts:44', correction: 'route the legacy path through the guard' },
  });
  assert.equal(r.statusCode, 201);
  const breaches = await app.inject({ method: 'GET', url: `/api/projects/${slug}/breaches`, headers: H(auditor.key) });
  assert.equal(breaches.json().breaches[0].discoveringSeat, 'auditor-1', 'the seat that found it is named on the record');

  // ── the resolved ledger applies waivers ────────────────────────────────
  await app.inject({
    method: 'POST', url: `/api/projects/${slug}/rows`, headers: asOp,
    payload: { rowId: 'J-01', requirement: 'legacy path is guarded', environment: 'staging', status: 'fail' },
  });
  const rows = await app.inject({ method: 'GET', url: `/api/projects/${slug}/ledger`, headers: H(auditor.key) });
  assert.equal(rows.statusCode, 200);
  const j01 = rows.json().rows.find((x: { rowId: string }) => x.rowId === 'J-01');
  assert.equal(j01.status, 'waived', 'a resolved fail with a live waiver reads as waived');
  assert.ok(j01.waiver.expiresAt, 'and the waiver travels with the row');

  // the waived row is counted, not hidden
  assert.equal(rows.json().counts.waived, 1);
  assert.equal(rows.json().breaches, 1);
});
