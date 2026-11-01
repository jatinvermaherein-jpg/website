// Crew supervisor — ONE CREW = ONE PROCESS GROUP.
//
// Spawned detached (own PGID == its own PID). It spawns its workers WITHOUT
// detaching, so they inherit this group. Killing the group (kill -PGID) hits
// supervisor AND every worker at once — that is the kill contract:
//   SIGTERM to the group → each worker stops cleanly (partial stays) →
//   supervisor marks `killing`, grants 3s → SIGKILL to the group → `killed`.
//
// Seats carry roles: builders do the work; auditors review the builders'
// partials as they land. The role spec arrives as a comma list, one entry
// per seat, aligned to the worker index.
//
// State is written to <outDir>/state.json after every transition; the API
// reads that file (fail-open) — the crew outlives the API that started it.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [, , runId, outDir, workerCount, taskTitle, durationMs, roleSpec] = process.argv;
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'crew-worker.mjs');
const stateFile = `${outDir}/state.json`;

const N = Number(workerCount);
const roleOf = (i) => (roleSpec ? roleSpec.split(',')[i - 1] || 'builder' : 'builder');

const state = {
  runId,
  status: 'running', // running → killing → killed | done
  pgid: process.pid,
  startedAt: Date.now(),
  taskTitle,
  roles: Array.from({ length: N }, (_, k) => roleOf(k + 1)),
  workers: [],
  partials: [],
};

function writeState() {
  try {
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {
    /* fail open — the stream is the record; the state file is a cache */
  }
}

mkdirSync(outDir, { recursive: true });
writeState();

const children = [];
for (let i = 1; i <= N; i++) {
  // NOT detached — the worker inherits this process group
  const p = spawn(process.execPath, [workerPath, outDir, String(i), String(durationMs), roleOf(i), String(N)], { stdio: 'ignore' });
  state.workers.push({ i, pid: p.pid, role: roleOf(i) });
  state.partials.push(`${outDir}/partial-${i}.log`);
  p.on('exit', () => {
    const w = state.workers.find((x) => x.i === i);
    if (w) w.exited = true;
    writeState();
    if (state.status === 'running' && state.workers.every((x) => x.exited)) {
      state.status = 'done';
      writeState();
      process.exit(0);
    }
  });
  children.push(p);
}
writeState();

process.on('SIGTERM', () => {
  state.status = 'killing';
  writeState();
  // workers are in the same group — they already got SIGTERM and stop
  // cleanly. After the grace: WRITE `killed` first (synchronously), then
  // make it final for the whole group.
  setTimeout(() => {
    state.status = 'killed';
    writeState();
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }, 3000);
});
