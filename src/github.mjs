// GITHUB — repo-per-department + 4 project repos, with create-or-update files.
//
//   All calls use GITHUB_TOKEN from the environment. The token is never
//   logged, never stored in a file, never returned in a response body.
//
//   The crew issues per-seat tokens (see crewcore addSeat); this module is
//   the operator-level client that creates repos and publishes cleared
//   cycles to them.

import { createHash } from 'node:crypto';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_API = process.env.GITHUB_API || 'https://api.github.com';
const CREW_OWNER = process.env.CREW_OWNER || 'jatinvermaherein-jpg';

if (!GITHUB_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn('[github] GITHUB_TOKEN not set — repo creation and publishing are disabled');
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export class GithubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = 'GithubError';
  }
}

async function gh(path, { method = 'GET', body = null, raw = false } = {}) {
  if (!GITHUB_TOKEN) throw new GithubError('GITHUB_TOKEN not configured', 503);
  const url = `${GITHUB_API}${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'crew-bus',
  };
  if (body && !raw) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, ...(body ? { body: raw ? body : JSON.stringify(body) } : {}) });
  const text = await res.text();
  let data;
  try { data = text.length ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new GithubError(`GitHub ${method} ${path}: ${res.status} ${data.message ?? text.slice(0, 200)}`, res.status);
  }
  return data;
}

// ── repos ──────────────────────────────────────────────────────────────────

export async function ensureRepo({ name, private: isPrivate = true, description = '' } = {}) {
  if (!name || !/^[a-z0-9][a-z0-9-]{1,90}$/.test(name)) {
    throw new GithubError('bad repo name', 400);
  }
  // try create; 422 = already exists, which is fine
  try {
    return await gh('/user/repos', {
      method: 'POST',
      body: { name, private: isPrivate, description, auto_init: false },
    });
  } catch (e) {
    if (e.status === 422) {
      return await gh(`/repos/${CREW_OWNER}/${encodeURIComponent(name)}`);
    }
    throw e;
  }
}

export async function getRepo({ owner = CREW_OWNER, repo }) {
  return await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
}

// ── files ──────────────────────────────────────────────────────────────────
//
//   createOrUpdateFile is the heart of "if a cycle changes an already saved
//   file it must be updated too". GET the path for its SHA, then PUT with
//   that SHA (update) or without it (create).

export async function getFileSha({ owner = CREW_OWNER, repo, path }) {
  try {
    const data = await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`);
    return data.sha ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function createOrUpdateFile({
  owner = CREW_OWNER,
  repo,
  path,
  content,        // string — will be base64 encoded
  message,
  branch = 'master',
  sha: existingSha,
}) {
  const encoded = Buffer.from(String(content)).toString('base64');
  return await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: {
      message: message || `crew: update ${path}`,
      content: encoded,
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
  });
}

export async function writeFiles({ owner = CREW_OWNER, repo, branch = 'master', message, files }) {
  const results = [];
  for (const f of files) {
    const existing = await getFileSha({ owner, repo, path: f.path });
    const r = await createOrUpdateFile({
      owner, repo, branch,
      path: f.path,
      content: f.content,
      message: f.message || message || `crew: update ${f.path}`,
      sha: existing,
    });
    results.push({ path: f.path, sha: r.content?.sha, updated: Boolean(existing) });
  }
  return results;
}

// ── project repo names ─────────────────────────────────────────────────────

export function projectRepos(projectSlug) {
  return {
    hqBot: `crew-${projectSlug}-hq-bot`,
    mainBot: `crew-${projectSlug}-main-bot`,
    website: `crew-${projectSlug}-website`,
    app: `crew-${projectSlug}-app`,
  };
}

export function deptRepo(projectSlug, deptId) {
  return `crew-${projectSlug}-dept-${deptId}`;
}

export function repoIsValid(name) {
  return /^[a-z0-9][a-z0-9-]{1,90}$/.test(name);
}
