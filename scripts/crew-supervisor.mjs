// Crew supervisor — ONE CREW = ONE PROCESS GROUP.
//
// Spawned detached (own PGID == its own PID). It spawns its workers WITHOUT
// detaching, so they inherit this group. Killing the group (kill -PGID) hits
// supervisor AND every worker at once — that is the kill contract:
//   SIGTERM to the group → each worker stops cleanly (partial stays) →
//   supervisor marks `killing`, grants 3s → SIGKILL to the group → `killed`.
//
// State is written to <outDir>/state.json after every transition; the API
// reads that file (fail-open) — the crew outlives the API that started it.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [, , runId, outDir, workerCount, taskTitle, durationMs] = process.argv;
const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'crew-worker.mjs');
const stateFile = `${outDir}/state.json`;

const state = {
  runId,
  status: 'running', // running → killing → killed | done
  pgid: process.pid,
  startedAt: Date.now(),
  taskTitle,
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
for (let i = 1; i <= Number(workerCount); i++) {
  // NOT detached — the worker inherits this process group
  const p = spawn(process.execPath, [workerPath, outDir, String(i), String(durationMs)], { stdio: 'ignore' });
  state.workers.push({ i, pid: p.pid });
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
