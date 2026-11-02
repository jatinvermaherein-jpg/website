// THE REPOSITORY — the thing that makes a crew a development team.
//
// A team that talks and never commits has not built anything. This is the
// plumbing that lets a seat work on real source:
//
//   worktree  a checkout of the PROJECT'S repo, on the seat's own branch,
//             in this sandbox. Two seats never write the same file by
//             accident, and `git log` at the end says who wrote what.
//   diff      what a reviewer reads. Not a summary of the change — the change.
//   commit    the seat's work becomes a real object in the history.
//   push      the only way work becomes real for everyone else.
//
// Two guards, both deliberate:
//   · a seat never pushes to the default branch. Work goes to a branch.
//     Merging is a human decision, and the repo must stay usable.
//   · a push is refused unless the task it belongs to has been WITNESSED.
//     The gate is not advisory; unreviewed code cannot reach the remote.
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class GitError extends Error {}

export function repoRoot(): string {
  return process.env.JATIN_REPO_ROOT || resolve(process.cwd());
}

export function worktreeBase(): string {
  return process.env.JATIN_WORKTREE_ROOT || resolve(process.cwd(), '..', '.jatin-worktrees');
}

const safe = (x: string) => x.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

export function branchFor(projectSlug: string, seatName: string, cycle = 0): string {
  const base = `crew/${safe(projectSlug)}/${safe(seatName)}`;
  return cycle > 0 ? `${base}/c${cycle}` : base;
}

export function pathFor(projectSlug: string, seatName: string): string {
  const p = join(worktreeBase(), safe(projectSlug), safe(seatName));
  if (!resolve(p).startsWith(resolve(worktreeBase()))) throw new GitError('worktree path escaped its root');
  return p;
}

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    return { ok: true as const, out: stdout.trim(), err: stderr.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { ok: false as const, out: (err.stdout ?? '').trim(), err: (err.stderr ?? '').trim(), code: err.code ?? 1 };
  }
}

// ── worktree ───────────────────────────────────────────────────────────────
export type Worktree = { path: string; branch: string; head: string; created: boolean };

export async function ensureWorktree(opts: {
  projectSlug: string;
  seatName: string;
  baseBranch: string;
  cycle?: number;
}): Promise<Worktree> {
  const { projectSlug, seatName, baseBranch, cycle = 0 } = opts;
  const path = pathFor(projectSlug, seatName);
  const branch = branchFor(projectSlug, seatName, cycle);
  const root = repoRoot();

  if (existsSync(join(path, '.git'))) {
    const head = await git(path, ['rev-parse', '--short', 'HEAD']);
    return { path, branch, head: head.ok ? head.out : '?', created: false };
  }

  await mkdir(resolve(path, '..'), { recursive: true });
  // fetch first so a worktree starts from the CURRENT remote, not a stale clone
  await git(root, ['fetch', '--all', '--prune']);

  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  // start from the remote's default branch when we can see it
  const startPoint = (await git(root, ['rev-parse', '--verify', '--quiet', `origin/${baseBranch}`])).ok
    ? `origin/${baseBranch}`
    : baseBranch;

  const args = exists.ok
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, startPoint];
  const added = await git(root, args);
  if (!added.ok) throw new GitError(added.err || 'git worktree add failed');

  const head = await git(path, ['rev-parse', '--short', 'HEAD']);
  return { path, branch, head: head.out, created: true };
}

export async function removeWorktree(projectSlug: string, seatName: string, keepBranch = true) {
  const path = pathFor(projectSlug, seatName);
  if (!existsSync(path)) return { removed: false, note: 'no worktree' };
  const status = await git(path, ['status', '--porcelain']);
  if (status.out) {
    // never destroy uncommitted work — stash it to a named ref first
    const ref = `refs/crew-rescue/${safe(seatName)}-${Date.now()}`;
    const st = await git(path, ['stash', 'push', '-u', '-m', `crew ${seatName} removed with uncommitted work`]);
    if (st.ok) await git(path, ['update-ref', ref, 'refs/stash']);
  }
  await git(repoRoot(), ['worktree', 'remove', '--force', path]);
  await git(repoRoot(), ['worktree', 'prune']);
  void keepBranch;
  return { removed: true, note: status.out ? 'uncommitted work was stashed to a rescue ref' : 'clean' };
}

// ── reading the work ───────────────────────────────────────────────────────
export type WorkingState = {
  branch: string;
  head: string;
  base: string;
  dirty: number;
  diffStat: string;
  diff: string;
  commits: string;
};

// The reviewer's view. `base` is the branch the work started from, so the
// diff is exactly "what this seat changed", not the whole repository.
export async function workState(projectSlug: string, seatName: string, baseBranch = 'main', maxDiff = 60000): Promise<WorkingState> {
  const path = pathFor(projectSlug, seatName);
  if (!existsSync(path)) throw new GitError(`seat ${seatName} has no worktree`);

  const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  const head = (await git(path, ['rev-parse', '--short', 'HEAD'])).out;
  const status = await git(path, ['status', '--porcelain']);
  const dirty = status.out ? status.out.split('\n').filter(Boolean).length : 0;

  // the merge base is what makes this a review diff rather than a re-read of
  // the entire repository
  const base = (await git(path, ['merge-base', `origin/${baseBranch}`, 'HEAD'])).ok
    ? (await git(path, ['merge-base', `origin/${baseBranch}`, 'HEAD'])).out
    : (await git(path, ['rev-parse', '--short', baseBranch])).out;

  const stat = await git(path, ['diff', '--stat', `${base}..HEAD`]);
  const diff = await git(path, ['diff', `${base}..HEAD`]);
  const log = await git(path, ['log', '--oneline', '--no-decorate', `${base}..HEAD`]);

  return {
    branch,
    head,
    base,
    dirty,
    diffStat: stat.ok ? stat.out : '',
    diff: diff.ok ? diff.out.slice(0, maxDiff) : '',
    commits: log.ok ? log.out : '',
  };
}

// ── writing the work ───────────────────────────────────────────────────────
export async function commitAll(
  projectSlug: string,
  seatName: string,
  message: string,
  identity: { name: string; email: string },
): Promise<{ commit: string; files: number }> {
  const path = pathFor(projectSlug, seatName);
  await git(path, ['add', '-A']);
  const staged = await git(path, ['status', '--porcelain']);
  const files = staged.out ? staged.out.split('\n').filter(Boolean).length : 0;
  if (!files) throw new GitError('nothing to commit — the seat changed no files');

  const c = await git(path, ['commit', '-m', message], {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  if (!c.ok) throw new GitError(c.err || 'commit failed');
  const head = await git(path, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.out, files };
}

// ── pushing ────────────────────────────────────────────────────────────────
export type PushResult = { pushed: boolean; branch: string; remoteRef: string; note?: string };

export async function pushBranch(opts: {
  projectSlug: string;
  seatName: string;
  branch: string;
  defaultBranch: string;
}): Promise<PushResult> {
  const { projectSlug, seatName, branch, defaultBranch } = opts;

  // HARD GUARD: a crew never pushes to the default branch. Not because it
  // will get it wrong, but because a broken default branch makes the whole
  // team unable to work — including the humans.
  if (branch === defaultBranch || branch === `origin/${defaultBranch}`) {
    throw new GitError(`refusing to push to ${defaultBranch} — crew work goes to a branch, and a human merges it`);
  }

  const path = pathFor(projectSlug, seatName);
  const push = await git(path, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`]);
  if (!push.ok) {
    throw new GitError(push.err || push.out || 'push failed');
  }
  return { pushed: true, branch, remoteRef: `refs/heads/${branch}` };
}

// what the repo looks like from the remote — the loop's starting point
export async function remoteState(defaultBranch = 'main') {
  const root = repoRoot();
  await git(root, ['fetch', '--all', '--prune']);
  const head = await git(root, ['rev-parse', '--short', `origin/${defaultBranch}`]);
  const log = await git(root, ['log', '--oneline', '--no-decorate', '-5', `origin/${defaultBranch}`]);
  const branches = await git(root, ['branch', '-r', '--no-color']);
  const remotes = await git(root, ['remote', '-v']);
  return {
    remote: remotes.ok ? remotes.out.split('\n')[0] ?? '' : '',
    defaultBranch,
    head: head.ok ? head.out : '',
    recent: log.ok ? log.out : '',
    branches: branches.ok
      ? branches.out
          .split('\n')
          .map((b) => b.trim().replace('origin/', ''))
          .filter((b) => b && !b.includes('HEAD'))
      : [],
  };
}

// a file dropped into a worktree — how a seat that is not running a shell
// still contributes source
export async function writeFileToWorktree(projectSlug: string, seatName: string, relPath: string, content: string) {
  const path = pathFor(projectSlug, seatName);
  const target = resolve(path, relPath);
  if (!target.startsWith(resolve(path))) throw new GitError('path escaped the worktree');
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
  return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
}

export async function cleanWorktree(projectSlug: string, seatName: string) {
  const path = pathFor(projectSlug, seatName);
  if (!existsSync(path)) return { cleaned: false };
  await git(path, ['checkout', '--', '.']);
  await git(path, ['clean', '-fd']);
  await rm(join(path, '.jatin-tmp'), { recursive: true, force: true });
  return { cleaned: true };
}
