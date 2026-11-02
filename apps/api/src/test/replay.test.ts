// A signed webhook that can be replayed is not a webhook, it is an open door.
// Both halves are required: an age check alone lets an attacker replay inside
// the window; a seen-set alone lets them fill memory with ancient timestamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayGuard } from '../lib/replay.js';

test('replay window: age AND seen-set, with the boundary asserted', () => {
  let t = 1_000_000;
  const g = new ReplayGuard({ windowMs: 5 * 60_000, now: () => t });
  const sig = 'sha256:abc';

  assert.equal(g.accept(sig, t).ok, true, 'a fresh signed call is accepted');
  assert.equal(g.accept(sig, t).ok, false, 'the same call twice is refused');
  assert.equal(g.accept(sig, t).reason, 'already-seen');

  t += 4 * 60_000;
  assert.equal(g.accept('sha256:def', t - 4 * 60_000).ok, true, 'inside the window is fine');
  assert.equal(g.accept('sha256:ghi', t - 5 * 60_000 - 1).ok, false, 'one ms over five minutes is refused');
  assert.equal(g.accept('sha256:ghi', t - 5 * 60_000 - 1).reason, 'too-old');

  t += 30 * 60_000;
  assert.equal(g.accept('sha256:jkl', t + 10 * 60_000).ok, false, 'a call from the far future is refused');
  assert.equal(g.accept('sha256:jkl', t + 10 * 60_000).reason, 'from-the-future');
});

test('replay window: the seen-set is bounded, and a replayed signature is still caught', () => {
  const g = new ReplayGuard({ windowMs: 60_000, now: () => 2_000_000, maxSeen: 3 });
  for (let i = 0; i < 50; i++) g.accept(`s${i}`, 2_000_000);
  // the bug this test found: pruning before the insert left the set at cap+1
  assert.ok(g.size() <= 3, `the set must stay bounded, got ${g.size()}`);

  const recent = new ReplayGuard({ windowMs: 60_000, now: () => 2_000_000, maxSeen: 100 });
  assert.equal(recent.accept('x', 2_000_000).ok, true);
  assert.equal(recent.accept('x', 2_000_000).ok, false, 'still caught while it is in the window');
});
