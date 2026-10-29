// .env loader — no dependency, no override of real env (12-factor).
// Candidates: apps/api/.env (deploy override), then repo-root .env (dev).
import { readFileSync, existsSync } from 'node:fs';

export function loadDotEnv(): void {
  const candidates = [
    new URL('../../.env', import.meta.url).pathname,
    new URL('../../../.env', import.meta.url).pathname,
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      const name = m?.[1];
      const value = m?.[2];
      if (name && value !== undefined && !(name in process.env)) {
        process.env[name] = value.replace(/^["']|["']$/g, '');
      }
    }
    return;
  }
}

// side effect on import — idempotent, never overrides real env.
loadDotEnv();
