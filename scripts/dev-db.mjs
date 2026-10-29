#!/usr/bin/env node
/**
 * Dev-only embedded Postgres (law: 127.0.0.1 — never exposed).
 * First run: initdb into .pgdata/ (persistent across restarts).
 * Then: runs the server in the FOREGROUND on 127.0.0.1:5432 so the process
 * manager can track and stop it cleanly.
 *
 *   node scripts/dev-db.mjs
 *
 * Auth: trust (local only) — the password in DATABASE_URL is accepted.
 */
import { initdb, postgres } from '@embedded-postgres/linux-x64';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, '.pgdata');
const port = 5432;

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

if (!existsSync(resolve(dataDir, 'PG_VERSION'))) {
  mkdirSync(dataDir, { recursive: true });
  console.log('[dev-db] first run → initdb');
  await run(initdb, ['-D', dataDir, '-U', 'jatin', '-A', 'trust', '-E', 'UTF8', '--no-locale']);
}

console.log(`[dev-db] postgres listening on 127.0.0.1:${port} (foreground — Ctrl-C to stop)`);
const server = spawn(
  postgres,
  ['-D', dataDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=/tmp'],
  { stdio: 'inherit' },
);
server.on('exit', (code) => process.exit(code ?? 0));
