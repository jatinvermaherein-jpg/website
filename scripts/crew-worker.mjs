// Crew worker — a real participant on the bus, not a metronome.
//
// The old version appended a random hex string to a file every 200ms. It
// produced the appearance of activity and none of the substance: nothing it
// did was visible to the team, and nothing it did depended on anyone else.
//
// This one holds a run-scoped token and behaves like a seat:
//   · posts presence and progress to the bus (so the board shows the work)
//   · reads its inbox (so it can be told something mid-run)
//   · writes its partial to disk (so a kill leaves evidence, not a void)
//   · on SIGTERM: says what it got done, then stops
//
// The intelligence is pluggable — set JATIN_WORK_CMD and each tick runs it.
// Without one, the worker posts a heartbeat unit and counts its own work,
// which is honest: it is a harness proving the rails, not an agent pretending
// to think.
import { appendFileSync } from 'node:fs';

const [outDir, i, durationMs, role, total] = process.argv.slice(2);
const n = Number(total) || 1;
const me = Number(i);
const path = `${outDir}/partial-${i}.log`;

const BASE = (process.env.JATIN_API_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PROJECT = process.env.JATIN_PROJECT || '';
const TOKEN = process.env.JATIN_SEAT_TOKEN || '';
const SEAT = process.env.JATIN_SEAT || `worker-${i}`;
const WORK_CMD = process.env.JATIN_WORK_CMD || '';

let units = 0;
let stopping = false;
let lastCursor = '0';
let inboxSeen = 0;

function write(line) {
  appendFileSync(path, `${line}\n`);
}

async function post(text, extra = {}) {
  if (!PROJECT || !TOKEN) return;
  try {
    await fetch(`${BASE}/api/projects/${PROJECT}/stream`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', body: { text, ...extra } }),
    });
  } catch {
    /* the bus being unreachable must not kill the work */
  }
}

async function readInbox() {
  if (!PROJECT || !TOKEN) return;
  try {
    const res = await fetch(`${BASE}/api/projects/${PROJECT}/stream?afterSeq=${lastCursor}&limit=50`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) return;
    const d = await res.json();
    lastCursor = d.nextCursor || lastCursor;
    const mine = (d.events || []).filter((e) => e.body && e.body.to === SEAT);
    for (const e of mine) {
      inboxSeen++;
      write(`INBOX t=${units * 200}ms · ${e.actor}: ${String(e.body.text || '').slice(0, 200)}`);
    }
  } catch {
    /* ignore */
  }
}

if (WORK_CMD) {
  const { execSync } = await import('node:child_process');
  void execSync; // resolved lazily inside the tick
}

void post(`${SEAT} joined as ${role} (worker ${me}/${n})`, { to: 'all' });

const timer = setInterval(async () => {
  units += 1;
  const t = units * 200;

  if (WORK_CMD) {
    try {
      const { execSync } = await import('node:child_process');
      const out = execSync(WORK_CMD, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      write(`worker ${me} t=${t}ms · ran work · ${String(out).trim().slice(-160)}`);
    } catch (e) {
      write(`worker ${me} t=${t}ms · work failed · ${String(e.message).slice(0, 160)}`);
    }
  } else {
    write(`worker ${me} t=${t}ms · heartbeat unit ${units} (no JATIN_WORK_CMD — harness only)`);
  }

  // every 5th unit is visible to the team, so the bus shows the work
  if (units % 5 === 0) void post(`${SEAT}: ${units} units, ${role}`, { to: 'all', units, role });
  if (units % 10 === 0) void readInbox();

  if (t >= Number(durationMs)) {
    clearInterval(timer);
    write(`worker ${me} COMPLETE at ${t}ms · ${units} units`);
    void post(`${SEAT}: finished ${units} units (${role})`, { to: 'all', done: true });
    process.exit(0);
  }
}, 200);

process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  write(`worker ${me} SIGTERM at ${units * 200}ms · ${units} units · partial kept`);
  void post(`${SEAT}: stopped at ${units} units — partial kept`, { to: 'all', stopped: true });
  setTimeout(() => process.exit(143), 120);
});
