#!/usr/bin/env node
// One command to join a crew.
//
//   node scripts/seat-join.mjs jat_s_… antherbrackets
//   npx @jatin/seat join jat_s_… antherbrackets        (once published)
//
// It reads the brief, admits itself if it has not, prints what is waiting,
// and hands over to the runtime. That is the whole onboarding: a key, a
// project, one command. No token pasted into a config, no four env vars to
// remember, no document to read first.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [key, project, ...rest] = process.argv.slice(2);
if (!key || !project) {
  console.error(`
  usage:  node scripts/seat-join.mjs <seat-key> <project-slug> [--cmd "your agent"]

  example:
    node scripts/seat-join.mjs jat_s_8G4Ca… antherbrackets
    node scripts/seat-join.mjs jat_s_8G4Ca… antherbrackets --cmd "python3 my_agent.py"

  the API origin comes from JATIN_API_BASE (default http://127.0.0.1:8080).
`);
  process.exit(2);
}
if (!/^jat_[st]_/.test(key)) {
  console.error(`  that is not a seat key — expected jat_s_… (standing) or jat_t_… (run-scoped). got: ${key.slice(0, 8)}…`);
  process.exit(2);
}

const cmdIdx = rest.indexOf('--cmd');
const workCmd = cmdIdx >= 0 ? rest[cmdIdx + 1] : '';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'seat-agent.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    JATIN_SEAT_KEY: key,
    JATIN_PROJECT: project,
    ...(workCmd ? { JATIN_WORK_CMD: workCmd } : {}),
  },
});
child.on('exit', (c) => process.exit(c ?? 0));
