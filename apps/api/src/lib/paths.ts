// Shared filesystem roots. REPO_ROOT is derived from this file's location
// (apps/api/src/lib → up 4) so it is stable regardless of the cwd the API
// was started from.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const WORKSPACE_ROOT = join(REPO_ROOT, 'workspace');
export const RUNS_ROOT = process.env.JATIN_RUNS_DIR || join(REPO_ROOT, 'runs');
