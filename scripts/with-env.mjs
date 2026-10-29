#!/usr/bin/env node
// Run a child command with the repo-root .env loaded (never overriding real
// env — 12-factor). Needed because the prisma CLI only reads .env from its
// cwd or the schema directory, not the repo root.
//
//   node scripts/with-env.mjs <cmd> [args...]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    const name = m?.[1];
    const value = m?.[2];
    if (name && value !== undefined && !(name in process.env)) {
      process.env[name] = value.replace(/^["']|["']$/g, '');
    }
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: with-env.mjs <cmd> [args...]');
  process.exit(2);
}
const p = spawn(cmd, args, { stdio: 'inherit', env: process.env });
p.on('exit', (code) => process.exit(code ?? 0));
