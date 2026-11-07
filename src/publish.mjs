// PUBLISH — when a cycle is cleared, its artifacts go to GitHub.
//
//   One workspace repo per department (created on demand).
//   Four project repos: hq-bot, main-bot, website, app.
//   If a file already exists in a repo, it is updated (SHA-based PUT), never
//   duplicated. This is the "already saved file must be updated too" rule.
//
//   All GitHub calls go through src/github.mjs, which needs GITHUB_TOKEN.

import {
  ensureRepo, getRepo, writeFiles, projectRepos, deptRepo, repoIsValid,
} from './github.mjs';

export class PublishError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
    this.name = 'PublishError';
  }
}

// ── cycle tracking (in board.json) ─────────────────────────────────────────

function cycleSeq(state, projectSlug) {
  const project = state.projects.find((p) => p.slug === projectSlug);
  if (!project) throw new PublishError(`no project ${projectSlug}`, 404);
  if (!project.cycles) project.cycles = [];
  return project;
}

export function startCycle(state, projectSlug, { by = 'operator' } = {}) {
  const project = cycleSeq(state, projectSlug);
  const cycle = {
    id: `cyc_${Date.now().toString(36)}`,
    startedAt: new Date().toISOString(),
    startedBy: by,
    startSeq: project.seq,
    status: 'open',
    clearedAt: null,
    published: false,
  };
  project.cycles.push(cycle);
  return cycle;
}

export function currentCycle(state, projectSlug) {
  const project = cycleSeq(state, projectSlug);
  return project.cycles.slice(-1)[0] ?? null;
}

export function clearCycle(state, projectSlug, { by = 'operator' } = {}) {
  const project = cycleSeq(state, projectSlug);
  const cycle = currentCycle(state, projectSlug);
  if (!cycle) throw new PublishError('no open cycle to clear', 404);
  if (cycle.status === 'cleared') throw new PublishError('cycle already cleared', 409);
  cycle.status = 'cleared';
  cycle.clearedAt = new Date().toISOString();
  cycle.clearedBy = by;
  cycle.endSeq = project.seq;
  return cycle;
}

// ── what changed in a cycle ────────────────────────────────────────────────

export function cycleChanges(project, cycle) {
  const from = cycle.startedAt ?? '1970-01-01T00:00:00.000Z';
  const to = cycle.clearedAt ?? new Date().toISOString();

  const messages = project.messages
    .filter((m) => m.at > from && m.at <= to)
    .map((m) => ({ seq: m.seq, at: m.at, from: m.from, type: m.type, text: m.text, dept: m.dept }));

  const docs = project.docs
    .filter((d) => d.at > from && d.at <= to)
    .map((d) => ({ slug: d.slug, version: d.version, title: d.title, kind: d.kind, body: d.body, dept: d.dept, at: d.at }));

  const suggestions = project.suggestions
    .filter((s) => s.at > from && s.at <= to);

  return { messages, docs, suggestions };
}

// ── publishing ─────────────────────────────────────────────────────────────

// One commit-like write per repo. Each repo gets the files relevant to it.
export async function publishCycle(state, projectSlug, { by = 'operator' } = {}) {
  const project = cycleSeq(state, projectSlug);
  const cycle = currentCycle(state, projectSlug);
  if (!cycle) throw new PublishError('no open cycle', 404);
  if (cycle.status === 'cleared' && cycle.published) {
    throw new PublishError('cycle already published', 409);
  }

  const changes = cycleChanges(project, cycle);
  const repos = projectRepos(projectSlug);
  const results = {};

  // ── 4 project repos ────────────────────────────────────────────────────
  for (const [kind, repoName] of Object.entries(repos)) {
    if (!repoIsValid(repoName)) {
      results[kind] = { error: `invalid repo name ${repoName}` };
      continue;
    }
    try {
      await ensureRepo({ name: repoName, private: true, description: `Crew ${kind} for ${projectSlug}` });
      const files = filesForKind(kind, changes, project);
      const written = await writeFiles({
        repo: repoName,
        branch: 'master',
        message: `crew: cycle ${cycle.id} cleared — ${files.length} file(s)`,
        files,
      });
      results[kind] = { repo: repoName, files: written.length, updated: written.filter((f) => f.updated).length };
    } catch (e) {
      results[kind] = { repo: repoName, error: e.message };
    }
  }

  // ── one workspace repo per department ──────────────────────────────────
  results.departments = {};
  for (const dept of project.departments) {
    const repoName = deptRepo(projectSlug, dept.id);
    if (!repoIsValid(repoName)) continue;
    try {
      await ensureRepo({ name: repoName, private: true, description: `Crew department ${dept.id} — ${projectSlug}` });
      const files = filesForDept(dept.id, changes, project);
      if (files.length === 0) {
        results.departments[dept.id] = { repo: repoName, files: 0, note: 'no changes this cycle' };
        continue;
      }
      const written = await writeFiles({
        repo: repoName,
        branch: 'master',
        message: `crew: cycle ${cycle.id} — ${dept.id} (${files.length} file(s))`,
        files,
      });
      results.departments[dept.id] = { repo: repoName, files: written.length, updated: written.filter((f) => f.updated).length };
    } catch (e) {
      results.departments[dept.id] = { repo: repoName, error: e.message };
    }
  }

  // mark published
  if (cycle.status === 'cleared') cycle.published = true;
  return { cycle: cycle.id, results };
}

// what each project repo receives
function filesForKind(kind, changes, project) {
  const files = [];
  const stamp = new Date().toISOString();

  // a manifest of what this cycle produced
  files.push({
    path: `cycles/${kind}-manifest.json`,
    content: JSON.stringify({
      project: project.slug,
      kind,
      cycle: changes,
      generatedAt: stamp,
    }, null, 2),
  });

  // docs go to every project repo as the integrated source of truth
  for (const d of changes.docs) {
    files.push({
      path: `docs/${d.slug}.md`,
      content: `# ${d.title}\n\nKind: ${d.kind}\nDepartment: ${d.dept}\n\n---\n\n${d.body}`,
    });
  }

  // the hq bot repo also gets the crew brief
  if (kind === 'hqBot') {
    files.push({
      path: 'CREW.md',
      content: `# Crew HQ — ${project.slug}\n\n` +
        `Departments: ${project.departments.map((d) => d.id).join(', ')}\n` +
        `Seats: ${project.seats.map((s) => `${s.id}(${s.kind})`).join(', ')}\n` +
        `Generated: ${stamp}\n`,
    });
  }

  // website repo gets an index pointing at the latest docs
  if (kind === 'website') {
    files.push({
      path: 'index.md',
      content: `# ${project.name}\n\n${changes.docs.map((d) => `- [${d.title}](./docs/${d.slug}.md)`).join('\n')}\n`,
    });
  }

  return files;
}

// department workspace repo gets only that department's docs + its messages
function filesForDept(deptId, changes, project) {
  const files = [];
  const stamp = new Date().toISOString();

  const deptDocs = changes.docs.filter((d) => d.dept === deptId);
  const deptMsgs = changes.messages.filter((m) => m.dept === deptId);

  for (const d of deptDocs) {
    files.push({
      path: `docs/${d.slug}.md`,
      content: `# ${d.title}\n\nVersion: ${d.version}\nKind: ${d.kind}\nGenerated: ${stamp}\n\n---\n\n${d.body}`,
    });
  }

  if (deptMsgs.length) {
    files.push({
      path: `bus/cycle-messages.json`,
      content: JSON.stringify({ department: deptId, messages: deptMsgs, generatedAt: stamp }, null, 2),
    });
  }

  return files;
}
