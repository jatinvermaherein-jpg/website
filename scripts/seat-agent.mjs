#!/usr/bin/env node
// JATIN SEAT — the real agent runtime.
//
// This is the thing that was missing. `crew-worker.mjs` was a metronome:
// it printed a random hex string to a file every 200ms and called it work.
// A crew built on that is a screenshot of a crew.
//
// This runtime obeys the protocol instead:
//
//   1. GET the brief            — who am I, what is this project, what rules
//   2. admit itself             — declare what it takes, what is stale
//   3. read the inbox           — what is waiting for me
//   4. claim a task             — the board is the work
//   5. run the work command     — YOUR agent, plugged in here
//   6. submit                   — with artifacts, for someone else to witness
//   7. handover                 — what I finished, what I did not, what's next
//   8. stop on SIGTERM/kill     — and say so on the bus before going
//
// Env:
//   JATIN_API_BASE   the API origin
//   JATIN_PROJECT    the project slug
//   JATIN_SEAT_KEY   standing key (jat_s_)  OR
//   JATIN_SEAT_TOKEN run-scoped token (jat_t_) when the crew spawned us
//   JATIN_WORK_CMD   the command that does the actual work (optional)
//   JATIN_SEAT_ROLE  lead | builder | auditor | scribe | scout
//   JATIN_SEAT       my name
//
// Nothing here needs a dependency. Node 20+.
const BASE = (process.env.JATIN_API_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PROJECT = process.env.JATIN_PROJECT || '';
const TOKEN = process.env.JATIN_SEAT_TOKEN || process.env.JATIN_SEAT_KEY || '';
// the seat's real role comes from the brief — the env var is only a hint
// for what to do if the server has not told us yet
let ROLE = process.env.JATIN_SEAT_ROLE || 'builder';
const WORK_CMD = process.env.JATIN_WORK_CMD || '';
const POLL_MS = Number(process.env.JATIN_POLL_MS || 2000);

if (!PROJECT || !TOKEN) {
  console.error('JATIN_PROJECT and (JATIN_SEAT_KEY | JATIN_SEAT_TOKEN) are required');
  process.exit(2);
}
if (!/^jat_[st]_/.test(TOKEN)) {
  console.error(`that does not look like a seat credential (expected jat_s_ or jat_t_, got ${TOKEN.slice(0, 6)}…)`);
  process.exit(2);
}

let ME = null; // filled from the brief
let cursor = '0';
let stopping = false;
let currentTask = null;
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, ok: res.ok, data };
}

// ── 1. brief ──────────────────────────────────────────────────────────────
async function brief() {
  const r = await api('GET', `/api/projects/${PROJECT}/brief`);
  if (!r.ok) {
    console.error(`could not read the brief (${r.status}): ${JSON.stringify(r.data)}`);
    process.exit(1);
  }
  return r.data;
}

// ── 2. admission ──────────────────────────────────────────────────────────
async function admit(b) {
  if (b.me.admitted) {
    log(`already admitted at ${b.me.admittedAt}`);
    return true;
  }
  const r = await api('POST', `/api/projects/${PROJECT}/stream`, {
    type: 'admission',
    body: {
      takes: `the ${ROLE} seat on ${b.project.slug} — ${b.running.length ? `joining ${b.running.length} run(s) in flight` : 'no runs in flight'}`,
      stale: `${b.docs.length === 0 ? 'the project has no documents yet' : `${b.docs.length} document(s) indexed`}; ruleset ${b.project.activeRulesetVersion ?? 'unset'}`,
      doesNotUnderstand: b.lastHandovers.length ? `the handover from ${b.lastHandovers[0].actor}: "${String(b.lastHandovers[0].next ?? '').slice(0, 120)}"` : 'nothing is handed over to me yet',
    },
  });
  if (r.status === 201) {
    log('admitted');
    return true;
  }
  console.error(`admission refused (${r.status}): ${JSON.stringify(r.data)}`);
  return false;
}

// ── 3. inbox ──────────────────────────────────────────────────────────────
async function inbox(since = '0') {
  const r = await api('GET', `/api/projects/${PROJECT}/inbox?since=${since}`);
  return r.ok ? r.data : { messages: [], head: since };
}

// ── the bus ───────────────────────────────────────────────────────────────
async function post(text, { type = 'message', to, refs } = {}) {
  const r = await api('POST', `/api/projects/${PROJECT}/stream`, {
    type,
    body: to ? { text, to } : { text },
    refs,
  });
  if (!r.ok) log(`post refused (${r.status}): ${JSON.stringify(r.data).slice(0, 180)}`);
  return r;
}

async function poll() {
  const r = await api('GET', `/api/projects/${PROJECT}/stream?afterSeq=${cursor}&limit=100`);
  if (!r.ok) return;
  cursor = r.data.nextCursor || cursor;
  for (const e of r.data.events || []) {
    const b = e.body || {};
    // the run ended — stop, as the protocol says to
    if (e.type === 'task' && (b.status === 'killed' || b.status === 'done')) {
      log(`run ended (${b.status}) — stopping`);
      shutdown(`run ${b.status}`);
    }
    if (b.text && e.actor !== ME) log(`← ${e.actor}${b.to ? ` → ${b.to}` : ''}: ${String(b.text).slice(0, 120)}`);
  }
}

// ── 4. work ───────────────────────────────────────────────────────────────
async function claimNext() {
  const board = await api('GET', `/api/projects/${PROJECT}/tasks?status=backlog`);
  if (!board.ok) return null;
  const mine = (board.data.tasks || []).find((t) => !t.ownerId);
  if (!mine) return null;
  const r = await api('POST', `/api/projects/${PROJECT}/tasks/${mine.id}/claim`);
  if (!r.ok) {
    log(`claim lost (${r.status}) — someone was first`);
    return null;
  }
  log(`claimed "${mine.title}" (${mine.id})`);
  currentTask = mine;
  return mine;
}

async function runWork(task) {
  if (!WORK_CMD) {
    log('no JATIN_WORK_CMD — I am a seat, not an autopilot. watching the bus.');
    return;
  }
  const started = Date.now();
  log(`running: ${WORK_CMD}`);
  const { execSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  let out = '';
  let ok = true;
  try {
    out = execSync(WORK_CMD, {
      encoding: 'utf8',
      timeout: Math.min(10 * 60_000, Number(process.env.JATIN_WORK_TIMEOUT_MS || 300_000)),
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, JATIN_TASK_ID: task.id, JATIN_TASK_TITLE: task.title },
    });
  } catch (e) {
    ok = false;
    out = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
  }
  const digest = 'sha256:' + createHash('sha256').update(out).digest('hex');
  const tail = out.slice(-400);

  await post(`worked "${task.title}" in ${Date.now() - started}ms — ${ok ? 'succeeded' : 'FAILED'} · ${digest}`, {
    type: 'answer',
    refs: { taskId: task.id, digest },
  });

  const sub = await api('POST', `/api/projects/${PROJECT}/tasks/${task.id}/submit`, {
    summary: `${tail}`.slice(0, 3000) || `ran ${WORK_CMD} (${ok ? 'exit 0' : 'non-zero'})`,
    artifacts: [],
  });
  log(sub.ok ? `submitted "${task.title}" for witness` : `submit refused: ${JSON.stringify(sub.data)}`);
  currentTask = null;
}

// ── 7. stop ───────────────────────────────────────────────────────────────
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  try {
    await api('POST', `/api/projects/${PROJECT}/handover`, {
      finished: currentTask ? `was mid-task on "${currentTask.title}"` : WORK_CMD ? 'watched the bus, took what was claimable' : 'stayed present on the bus',
      unfinished: currentTask ? `"${currentTask.title}" is still claimed by me and not submitted` : 'nothing outstanding',
      next: `stopping because ${reason}. the task board and the bus have the state; read the brief before acting`,
    });
    await post(`stopping — ${reason}`);
    log('handover written, stopping');
  } catch (e) {
    log('handover failed, still stopping', e?.message);
  }
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGTERM', () => shutdown('SIGTERM from the crew'));
process.on('SIGINT', () => shutdown('interrupted'));

// ── main ──────────────────────────────────────────────────────────────────
const b = await brief();
ME = b.me.name;
// the server is the authority on what this seat is; announcing the wrong role
// on the bus is how a crew ends up with auditors that think they build
ROLE = b.me.role || ROLE;
log(`seat ${ME} (${b.me.role}) on ${PROJECT} — admitted=${b.me.admitted} · bus head ${b.bus.head}`);
if (b.rules) log(`rules: ${b.rules.slug} v${b.rules.version} (${b.rules.bytes}b, ${b.rules.sha256.slice(0, 16)}…)`);
if (b.inbox?.waiting) log(`${b.inbox.waiting} message(s) waiting in my inbox`);
if (b.lastHandovers?.[0]) log(`last handover from ${b.lastHandovers[0].actor}: ${String(b.lastHandovers[0].next).slice(0, 120)}`);
if (b.team.length > 1) log(`team: ${b.team.map((s) => `${s.name}(${s.role})${s.online ? '' : '·off'}`).join(', ')}`);

if (!(await admit(b))) process.exit(1);

const inb = await inbox('0');
if (inb.messages?.length) {
  for (const m of inb.messages) log(`inbox · ${m.actor}: ${String(m.text ?? '').slice(0, 140)}`);
  cursor = inb.head || cursor;
}

// ── what the board says I should be doing ────────────────────────────────
// A builder with nothing to claim, or an auditor with something to witness,
// used to look identical from here: idle. That is how a crew turns back into
// a metronome. So say it out loud, from the brief's own nextStep.
async function reportStanding() {
  const r = await api('GET', `/api/projects/${PROJECT}/brief`);
  if (!r.ok) return;
  const board = r.data.board || {};
  const counts = board.counts || {};
  const waiting = board.witnessable || [];
  const awaiting = board.awaitingWitness || [];
  log(
    `board: ${counts.backlog ?? 0} backlog · ${counts.in_progress ?? 0} in progress · ${counts.review ?? 0} review · ${counts.done ?? 0} done`,
  );
  if (waiting.length) {
    log(`${waiting.length} task(s) awaiting MY witness: ${waiting.map((t) => `"${t.title}"`).join(', ')}`);
    log('  a witness needs a falsification attempt AND an instrument control — jatin_witness / POST …/witness');
  }
  if (awaiting.length) {
    log(`${awaiting.length} of my task(s) are in review, waiting on another seat to witness — not mine to close`);
  }
  if (r.data.me?.nextStep && r.data.me.nextStep !== 'read the bus, take work, file verdicts with a falsification attempt') {
    log(`next: ${r.data.me.nextStep}`);
  }
}

if (WORK_CMD) {
  const task = await claimNext();
  if (task) await runWork(task);
  else await reportStanding();
} else {
  await post(`seat ${ME} online (${ROLE}) — watching the bus`, { to: 'all' });
  await reportStanding();
}

setInterval(() => {
  if (!stopping) void poll();
}, POLL_MS);
