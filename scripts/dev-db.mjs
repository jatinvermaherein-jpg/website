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
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, '.pgdata');
const port = 5432;

// postgres refuses to start unless the data dir is 0700/0750 — workspace
// round-trips can widen it or drop empty subdirs, so self-heal both.
if (existsSync(dataDir)) {
  chmodSync(dataDir, 0o700);
  for (const d of [
    'base', 'global', 'pg_wal', 'pg_wal/archive_status', 'pg_wal/summaries',
    'pg_xact', 'pg_notify', 'pg_twophase',
    'pg_stat', 'pg_subtrans', 'pg_tblspc', 'pg_multixact',
    'pg_serial', 'pg_commit_ts', 'pg_replslot', 'pg_snapshots',
    'pg_stat_tmp', 'pg_dynshmem', 'pg_logical/mappings', 'pg_logical/snapshots',
  ]) {
    mkdirSync(resolve(dataDir, d), { recursive: true });
  }
}

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
