// Onboarding completeness: the two things a joining agent needs that the
// brief alone could not give it —
//   1. attachments it can actually open (bytes + real content type)
//   2. the project environment values, when the operator has opened them
//
// Both are about the same question the user asks: "does an agent have the
// same access I do?" The brief answers "here are the names". These answer
// "here is the file" and "here is the value", under their own rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createHash } from 'node:crypto';

test('onboarding: attachments download as bytes, env values reach an admitted seat only', async (t) => {
  const app = await buildApp();
  await app.ready();
  t.after(() => app.close());

  const operator = await prisma.user.findFirst({ where: { isOperator: true } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: operator!.username, password: process.env.ADMIN_PASSWORD! },
  });
  const asOp = { authorization: `Bearer ${login.json().token}` };
  const org = (await prisma.membership.findFirst({ where: { userId: operator!.id } }))!;

  const slug = `onb${Date.now().toString(36)}`;
  await prisma.project.create({ data: { orgId: org.orgId, slug, name: 'Onboarding', status: 'active' } });

  const mk = async (name: string, role: string) => {
    const r = await app.inject({ method: 'POST', url: `/api/projects/${slug}/seats`, headers: asOp, payload: { name, role } });
    return { id: r.json().seat.id as string, key: r.json().key as string };
  };
  const builder = await mk('onb-builder', 'builder');
  const H = (k: string) => ({ authorization: `Bearer ${k}` });

  // ── 1. an attachment: real bytes, real type, downloaded intact ──────────
  // A tiny PNG. The point is that the bytes survive the round trip — an
  // "attachment" stored as escaped JSON text is not an attachment.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngHash = createHash('sha256').update(png).digest('hex');

  let r = await app.inject({
    method: 'POST',
    url: `/api/projects/${slug}/docs`,
    headers: asOp,
    payload: { slug: 'screenshot', kind: 'attachment', title: 'a pixel', mime: 'image/png', body: png.toString('base64') },
  });
  assert.equal(r.statusCode, 201, 'an attachment is publishable');
  assert.equal(r.json().sha256, createHash('sha256').update(png.toString('base64')).digest('hex'));

  // the metadata route still returns the body as stored — that is the record
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/docs/screenshot`, headers: asOp });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().intact, true);

  // the raw route is the one an agent actually uses
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/docs/screenshot/raw`, headers: asOp });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'] as string, /image\/png/);
  assert.match(r.headers['content-disposition'] as string, /screenshot-v1\.png/);
  const served = Buffer.from(r.rawPayload);
  assert.equal(served.length, png.length, 'the byte length survives');
  assert.equal(createHash('sha256').update(served).digest('hex'), pngHash, 'and so do the bytes, exactly');

  // ── 2. env: names in the brief, values only through the seat door ───────
  // a variable opened to seats, and one deliberately not
  r = await app.inject({
    method: 'PUT', url: `/api/projects/${slug}/env/API_BASE`, headers: asOp,
    payload: { value: 'https://internal.example/api', seatVisible: true },
  });
  assert.equal(r.statusCode, 201, 'first write creates the variable');
  assert.equal(r.json().seatVisible, true, 'and the flag is honoured on create');

  r = await app.inject({
    method: 'PUT', url: `/api/projects/${slug}/env/STRIPE_SECRET`, headers: asOp,
    payload: { value: 'sk_live_shhh', seatVisible: false },
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().seatVisible, false);

  // the listing never carries a value, ever
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env`, headers: asOp });
  const listed = JSON.stringify(r.json());
  assert.equal(listed.includes('sk_live_shhh'), false, 'a list must never leak a value');
  assert.equal(listed.includes('internal.example'), false, 'not even the opened one');
  const apiBase = r.json().env.find((e: { name: string }) => e.name === 'API_BASE');
  assert.equal(apiBase.seatVisible, true, 'and it says which are open');

  // a session cannot use the values route — it is a seat door
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env/values`, headers: asOp });
  assert.equal(r.statusCode, 403, 'env values are handed to a seat, not to a session');

  // a seat that has not admitted itself gets nothing (D3)
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env/values`, headers: H(builder.key) });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /has not admitted itself/);

  // admit, then ask
  await app.inject({
    method: 'POST', url: `/api/projects/${slug}/stream`, headers: H(builder.key),
    payload: { type: 'admission', body: { takes: 'the onboarding walk', stale: 'nothing yet', doesNotUnderstand: 'which vars are mine' } },
  });

  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env/values`, headers: H(builder.key) });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().values.API_BASE, 'https://internal.example/api', 'the opened value arrives');
  assert.equal(r.json().values.STRIPE_SECRET, undefined, 'the closed one does not');
  assert.deepEqual(r.json().notOpenedToSeats, ['STRIPE_SECRET'], 'and the agent is told it exists, so it can ask');

  // every value handed over is a record — who read what, when
  const audited = await prisma.auditLog.findMany({ where: { action: 'env.inject', target: `${slug}/API_BASE` } });
  assert.ok(audited.length >= 1, 'the reveal is audited');
  assert.equal(audited.at(-1)!.actor, 'onb-builder', 'and it names the seat that read it');
  const secretReads = await prisma.auditLog.count({ where: { action: 'env.inject', target: `${slug}/STRIPE_SECRET` } });
  assert.equal(secretReads, 0, 'the value nobody opened was never decrypted for a seat');

  // rotating a value does not silently change who can read it
  await app.inject({
    method: 'PUT', url: `/api/projects/${slug}/env/API_BASE`, headers: asOp,
    payload: { value: 'https://internal.example/v2' },
  });
  r = await app.inject({ method: 'GET', url: `/api/projects/${slug}/env/values`, headers: H(builder.key) });
  assert.equal(r.json().values.API_BASE, 'https://internal.example/v2', 'the new value is served');
  assert.deepEqual(r.json().notOpenedToSeats, ['STRIPE_SECRET'], 'and the opened/closed split is unchanged');
});
