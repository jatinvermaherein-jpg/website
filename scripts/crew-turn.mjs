#!/usr/bin/env node
// ONE TURN OF A CREW THAT NOBODY HAS TO START.
//
// Runs inside GitHub Actions on a schedule. No sandbox of mine, no chat of
// yours, no daemon that dies when a box is reclaimed — the runner is the
// host, and it exists whether anyone is watching or not.
//
// The board lives in the repository (crew/board.json), so the bus and the
// source of truth are the same object. A turn is:
//
//   read board → pick one task → ask the model for the files
//   → write them in a worktree → run the tests → commit → push a branch
//   → update the board → exit
//
// Stateless by design: the next run reads the board and continues. That is
// what makes "non-stop" work without holding anything alive.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.env.GITHUB_WORKSPACE || process.cwd();
const BOARD = join(ROOT, 'crew', 'board.json');
const BASE = (process.env.MODEL_BASE || 'https://text.pollinations.ai/openai').replace(/\/$/, '');
const MODEL = process.env.MODEL || 'openai';
const KEY = process.env.MODEL_KEY || '';
const SEAT = process.env.CREW_SEAT || 'builder-1';
const ROLE = process.env.CREW_ROLE || 'builder';
const MAX_TRIES = Number(process.env.MODEL_TRIES || 6);

const sh = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();

const log = (...a) => console.log(`[crew ${new Date().toISOString().slice(11, 16)}]`, ...a);

function readBoard() {
  if (!existsSync(BOARD)) return { cycle: 0, tasks: [] };
  return JSON.parse(readFileSync(BOARD, 'utf8'));
}
function writeBoard(b) {
  mkdirSync(dirname(BOARD), { recursive: true });
  writeFileSync(BOARD, JSON.stringify(b, null, 2) + '\n');
}

// ── the mind ───────────────────────────────────────────────────────────────
// Any OpenAI-compatible endpoint. Pollinations needs no key at all, so a
// crew can run on a schedule with zero accounts. A key removes the rate
// limit; it does not add capability.
async function think(messages) {
  for (let i = 1; i <= MAX_TRIES; i++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0.2 }),
      });
      const text = await res.text();
      if (res.status === 429 || res.status === 402) {
        const wait = Number(text.match(/retry[_ ]after["\s:]*(\d+)/i)?.[1] ?? text.match(/every (\d+)/i)?.[1] ?? 30);
        log(`rate limited — waiting ${wait}s (try ${i}/${MAX_TRIES})`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        log(`model ${res.status}: ${text.slice(0, 160)}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const j = JSON.parse(text);
      return j.choices?.[0]?.message?.content ?? '';
    } catch (e) {
      log(`model error: ${String(e.message).slice(0, 120)} — retry ${i}/${MAX_TRIES}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return '';
}

// The model returns files as JSON. Everything outside the first { and the
// last } is chatter, and small models always add chatter.
function parseFiles(raw) {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(raw.slice(a, b + 1));
    if (!Array.isArray(j.files) || !j.files.length) return null;
    return j.files
      .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
      .filter((f) => !f.path.includes('..') && !f.path.startsWith('/'))
      .map((f) => ({ path: f.path, content: f.content }));
  } catch {
    return null;
  }
}

// ── one turn ───────────────────────────────────────────────────────────────
async function main() {
  const board = readBoard();
  const task = board.tasks.find((t) => t.status === 'todo');
  if (!task) {
    log('no work on the board — standing down. this is the correct state, not a failure');
    return;
  }

  log(`seat ${SEAT} (${ROLE}) — task: ${task.title}`);
  const branch = `crew/${SEAT}/${task.id}`;

  // a fresh branch off the default branch, every time. Two turns can never
  // trip over each other, and every turn is reviewable as a diff.
  sh(['fetch', 'origin', '--prune']);
  sh(['checkout', '-B', branch, `origin/${process.env.GITHUB_REF_NAME || 'master'}`]);

  const prompt = [
    {
      role: 'system',
      content:
        'You are a software engineer on a team. You return ONLY a JSON object, no prose:\n' +
        '{"files":[{"path":"relative/path.ts","content":"FULL file contents"}],"commitMessage":"one line"}\n' +
        'Write complete files, not diffs. If you must change an existing file, return its entire new content. ' +
        'Keep the change small and focused on the task.',
    },
    {
      role: 'user',
      content:
        `TASK: ${task.title}\n\n${task.description || ''}\n\n` +
        `ACCEPTANCE: ${task.acceptance || 'it does what the task says'}\n\n` +
        `Repository root files: ${readdirSync(ROOT).filter((f) => !f.startsWith('.')).join(', ')}\n` +
        'Return the files to create or change.',
    },
  ];

  const raw = await think(prompt);
  const files = parseFiles(raw);
  if (!files) {
    log('the model returned no usable files — leaving the task alone rather than faking progress');
    task.status = 'todo';
    task.attempts = (task.attempts || 0) + 1;
    writeBoard(board);
    return;
  }

  for (const f of files) {
    const p = join(ROOT, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    log(`wrote ${f.path} (${f.content.length} bytes)`);
  }

  // TEST BEFORE COMMITTING. A crew that commits untested code is a crew
  // that fills the branch list with things a human has to clean up.
  let testNote = 'no test command configured';
  try {
    testNote = execFileSync('npm', ['test', '--silent'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' }).slice(-400);
    log('tests passed');
  } catch (e) {
    const out = String(e.stdout || e.message).slice(-600);
    log('TESTS FAILED — not committing');
    task.status = 'todo';
    task.attempts = (task.attempts || 0) + 1;
    task.lastFailure = out.slice(-300);
    writeBoard(board);
    sh(['checkout', '--', '.']);
    return;
  }

  // commit as the seat, so `git log` says who did what
  sh(['config', 'user.name', SEAT]);
  sh(['config', 'user.email', `${SEAT}@crew.local`]);
  sh(['add', '-A']);
  const msg = task.title.replace(/"/g, "'");
  sh(['commit', '-m', `${msg}\n\ntask ${task.id} · seat ${SEAT} · ${files.length} file(s)`]);
  const sha = sh(['rev-parse', '--short', 'HEAD']);
  log(`committed ${sha}`);

  sh(['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  log(`pushed ${branch}`);

  task.status = 'review';
  task.owner = SEAT;
  task.branch = branch;
  task.commit = sha;
  task.testNote = String(testNote).slice(-200);
  board.cycle = (board.cycle || 0) + 1;
  writeBoard(board);

  // the board update rides on master so the next run sees it
  sh(['add', 'crew/board.json']);
  sh(['commit', '-m', `board: ${task.id} → review (${sha})`]);
  sh(['push', 'origin', `HEAD:refs/heads/${process.env.GITHUB_REF_NAME || 'master'}`]);
  log('board updated on the default branch — next run continues from here');
}

main().catch((e) => {
  console.error('crew turn failed:', e.message);
  process.exit(1);
});
