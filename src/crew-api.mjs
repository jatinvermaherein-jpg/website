#!/usr/bin/env node
// CREW API — the bus your extension and website talk to.
//
//   One Railway service does everything: crew API + static website.
//   No Netlify, no VPS, no always-on host beyond Railway.
//
//   Dependency-free: stdlib HTTP + crewcore.mjs only. No Prisma, no Supabase,
//   no build step. `node src/crew-api.mjs` and it is up.
//
//   State lives in crew/board.json, written atomically (tmp + rename), so a
//   mid-write crash leaves the last good board — the bus is the source of
//   truth and it survives restarts, redeploys and power cuts.
//
//   Every endpoint below is one of your eleven requirements, and nothing
//   else.
//
//   Auth: `X-Seat-Key` header holding the seat's key (returned once when the
//   seat is created). readEnv / postMessage require it. The operator uses
//   `X-Operator: 1` to bypass seat auth and read everything (requirement 8).

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, createReadStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  newState, createProject, addDepartment, addSeat, seatFromKey,
  postMessage, suggest, setEnv, readEnv, transcript, addDoc, readDoc,
  admit, brief, CrewError,
} from './crewcore.mjs';
import {
  startCycle, clearCycle, currentCycle, publishCycle,
} from './publish.mjs';
import { ensureRepo, projectRepos, deptRepo, repoIsValid } from './github.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_PATH = join(REPO_ROOT, 'crew', 'board.json');
const STATIC_DIR = join(REPO_ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT || 8080);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
};

// ── persistence ────────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_PATH)) return newState();
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    // a corrupt board is refused, never overwritten — someone must inspect it
    throw new Error(`corrupt board at ${STATE_PATH}; refusing to start`);
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH); // atomic on POSIX
  // the repo is the only memory: commit board.json back to git so it survives
  // redeploys, restarts and power cuts. best-effort — gated by CREW_GIT_REMOTE.
  persistToGit();
}

function persistToGit() {
  const remote = process.env.CREW_GIT_REMOTE;
  if (!remote) return; // not configured — state lives only in this container
  try {
    execSync('git add crew/board.json', { cwd: REPO_ROOT, stdio: 'pipe' });
    // no-op if nothing changed
    const status = execSync('git status --porcelain crew/board.json', { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();
    if (!status) return;
    execSync('git -c user.email=crew@railway -c user.name=crew commit -q crew/board.json -m "crew: board update"', { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync(`git push ${remote} HEAD:${process.env.CREW_GIT_BRANCH || 'master'}`, { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (e) {
    // best effort — the bus keeps running even if the push fails
    // eslint-disable-next-line no-console
    console.log('[crew] git persist skipped:', String(e && e.stderr ? e.stderr : e.message || e).slice(0, 200));
  }
}

let STATE = loadState();
setInterval(() => { try { saveState(STATE); } catch { /* best-effort snapshot */ } }, 30_000);

// ── helpers ────────────────────────────────────────────────────────────────
const json = (reply, code, body) => {
  reply.writeHead(code, { 'Content-Type': 'application/json' });
  reply.end(JSON.stringify(body));
};
const err = (reply, e) => json(reply, e.code ?? 500, { error: e.message });
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const seatOf = (state, headers) => {
  const key = headers['x-seat-key'];
  if (!key) throw new CrewError('provide X-Seat-Key (the key the seat was given at creation)', 401);
  const h = hash(key);
  const project = state.projects.find((p) => p.seats.some((s) => s.keyHash === h));
  if (!project) throw new CrewError('unknown seat key', 401);
  const seat = project.seats.find((s) => s.keyHash === h);
  return { project, seat };
};
const operator = (headers) => headers['x-operator'] === '1';
const param = (url, name) => new URL(url, `http://localhost`).searchParams.get(name);

// ── static file serving ────────────────────────────────────────────────────
function serveStatic(reply, filePath) {
  try {
    const st = statSync(filePath);
    const ext = join(filePath, 'x').slice(-4).toLowerCase(); // crude but works for common ext
    const ct = CONTENT_TYPES['.' + filePath.split('.').pop()] || 'application/octet-stream';
    reply.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size });
    createReadStream(filePath).pipe(reply);
  } catch {
    reply.writeHead(404, { 'Content-Type': 'text/plain' });
    reply.end('not found');
  }
}

// ── router ─────────────────────────────────────────────────────────────────
const handle = async (req, reply) => {
  const { method, url, headers } = req;
  const pathname = new URL(url, `http://localhost`).pathname;

  // CORS so the extension can call the bus from any origin
  reply.setHeader('Access-Control-Allow-Origin', '*');
  reply.setHeader('Access-Control-Allow-Headers', 'content-type, x-seat-key, x-operator');
  reply.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (method === 'OPTIONS') return json(reply, 204, {});

  const body = await new Promise((res, rej) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => res(d));
    req.on('error', rej);
  });
  const parse = () => { try { return body.length ? JSON.parse(body) : {}; } catch { throw new CrewError('invalid JSON body', 400); } };

  try {
    // ────────── API routes ──────────
    if (pathname === '/health' && method === 'GET') return json(reply, 200, { ok: true, projects: STATE.projects.length });

    if (pathname === '/projects' && method === 'GET') {
      return json(reply, 200, STATE.projects.map((p) => ({ slug: p.slug, name: p.name, createdAt: p.createdAt, depts: p.departments.length, seats: p.seats.length })));
    }
    if (pathname === '/projects' && method === 'POST') {
      const { slug, name, by } = parse();
      const p = createProject(STATE, { slug, name, by: by || 'operator' });
      saveState(STATE);
      return json(reply, 201, { slug: p.slug, name: p.name, createdAt: p.createdAt });
    }

    const slugRoute = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
    if (slugRoute) {
      const slug = slugRoute[1];
      const sub = slugRoute[2] || '';
      const project = STATE.projects.find((p) => p.slug === slug);
      if (!project) throw new CrewError(`no project ${slug}`, 404);

      // project summary
      if (sub === '' || sub === '/') {
        if (method === 'GET') {
          return json(reply, 200, {
            slug: project.slug, name: project.name,
            departments: project.departments,
            seats: project.seats.map((s) => ({ id: s.id, dept: s.dept, kind: s.kind, admitted: Boolean(s.admittedAt) })),
            env: project.env.map((e) => e.name),
            docs: [...new Set(project.docs.map((d) => d.slug))],
            messages: project.messages.length,
            suggestions: project.suggestions.length,
          });
        }
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }

      // ────────── 2. departments ──────────
      if (sub === '/departments') {
        if (method === 'POST') {
          const { id: deptId, name, liaison } = parse();
          const d = addDepartment(project, { id: deptId, name, liaison });
          saveState(STATE);
          return json(reply, 201, d);
        }
        if (method === 'GET') return json(reply, 200, project.departments);
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }

      // ────────── 3. agents (seats: worker / auditor) ──────────
      if (sub === '/seats') {
        if (method === 'POST') {
          const { id: seatId, dept, kind } = parse();
          const { seat, key } = addSeat(project, { id: seatId, dept, kind, createdBy: 'operator' });
          saveState(STATE);
          return json(reply, 201, { seat: { id: seat.id, dept: seat.dept, kind: seat.kind }, key });
        }
        if (method === 'GET') {
          return json(reply, 200, project.seats.map((s) => ({ id: s.id, dept: s.dept, kind: s.kind, admitted: Boolean(s.admittedAt) })));
        }
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }

      // ────────── 4+5. messages + suggestions ──────────
      if (sub === '/messages') {
        if (method === 'POST') {
          const { type, text, to, via } = parse();
          const { seat } = seatOf(STATE, headers);
          if (!seat.admittedAt) throw new CrewError('admit yourself before speaking — GET /brief/:id first', 403);
          const msg = postMessage(project, seat, { type: type || 'chat', text, to, via });
          saveState(STATE);
          return json(reply, 201, msg);
        }
        if (method === 'GET') {
          const since = Number(param(url, 'since') || 0);
          const limit = Number(param(url, 'limit') || 200);
          return json(reply, 200, transcript(project, { since, limit }));
        }
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }
      if (sub === '/suggestions') {
        if (method === 'POST') {
          const { text, about } = parse();
          const seat = headers['x-seat-key'] ? seatOf(STATE, headers).seat : null;
          const s = suggest(project, seat ?? undefined, { text, about });
          saveState(STATE);
          return json(reply, 201, s);
        }
        if (method === 'GET') return json(reply, 200, project.suggestions);
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }

      // ────────── 6+7. universal env + secrets ──────────
      if (sub === '/env') {
        if (method === 'POST') {
          if (!operator(headers)) throw new CrewError('only the operator writes the env', 403);
          const { name, value, by } = parse();
          const r = setEnv(project, { name, value, by: by || 'operator' });
          saveState(STATE);
          return json(reply, 200, r);
        }
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }
      if (sub === '/env/read') {
        if (method !== 'GET') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const names = param(url, 'names')?.split(',').filter(Boolean);
        const { seat } = seatOf(STATE, headers);
        const values = readEnv(project, seat, names ? { names } : {});
        saveState(STATE);
        return json(reply, 200, values);
      }

      // ────────── 9. versioned docs ──────────
      if (sub === '/docs') {
        if (method === 'POST') {
          const { seat } = seatOf(STATE, headers);
          const { slug: dSlug, title, body, kind } = parse();
          const d = addDoc(project, seat, { slug: dSlug, title, body, kind: kind || 'doc' });
          saveState(STATE);
          return json(reply, 201, d);
        }
        if (method === 'GET') {
          return json(reply, 200, [...new Set(project.docs.map((d) => d.slug))].map((s) => {
            const latest = readDoc(project, s);
            return { slug: s, version: latest.version, title: latest.title, kind: latest.kind };
          }));
        }
        throw new CrewError(`no route ${method} ${pathname}`, 405);
      }
      const dRoute = sub.match(/^\/docs\/([^/]+)$/);
      if (dRoute && method === 'GET') {
        const version = param(url, 'version') ? Number(param(url, 'version')) : null;
        return json(reply, 200, readDoc(project, dRoute[1], version));
      }

      // ────────── 10+11. onboarding ──────────
      if (sub === '/admit') {
        if (method !== 'POST') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const { seat } = seatOf(STATE, headers);
        const { takes, stale, doesNotUnderstand } = parse();
        const a = admit(project, seat, { takes, stale, doesNotUnderstand });
        saveState(STATE);
        return json(reply, 200, a);
      }
      const briefRoute = sub.match(/^\/brief\/([^/]+)$/);
      if (briefRoute && method === 'GET') {
        const target = project.seats.find((s) => s.id === briefRoute[1]);
        if (!target) throw new CrewError(`no seat ${briefRoute[1]}`, 404);
        return json(reply, 200, brief(project, target));
      }

      // ────────── cycle + publish ──────────
      if (sub === '/cycle/start') {
        if (method !== 'POST') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const { by } = parse();
        const c = startCycle(STATE, slug, { by: by || 'operator' });
        saveState(STATE);
        return json(reply, 201, c);
      }
      if (sub === '/cycle/clear') {
        if (method !== 'POST') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const { by } = parse();
        const c = clearCycle(STATE, slug, { by: by || 'operator' });
        saveState(STATE);
        return json(reply, 200, c);
      }
      if (sub === '/cycle/status') {
        if (method !== 'GET') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const c = currentCycle(STATE, slug);
        return json(reply, 200, c ?? { status: 'no cycle' });
      }
      if (sub === '/cycle/publish') {
        if (method !== 'POST') throw new CrewError(`no route ${method} ${pathname}`, 405);
        const { by } = parse();
        const result = await publishCycle(STATE, slug, { by: by || 'operator' });
        saveState(STATE);
        return json(reply, 200, result);
      }
      if (sub === '/repos/ensure') {
        if (method !== 'POST') throw new CrewError(`no route ${method} ${pathname}`, 405);
        if (!operator(headers)) throw new CrewError('only the operator ensures repos', 403);
        const results = {};
        for (const [kind, repoName] of Object.entries(projectRepos(slug))) {
          try {
            const r = await ensureRepo({ name: repoName, private: true, description: `Crew ${kind} — ${slug}` });
            results[kind] = { repo: repoName, created: Boolean(r.id), html_url: r.html_url };
          } catch (e) {
            results[kind] = { repo: repoName, error: e.message };
          }
        }
        for (const dept of project.departments) {
          const repoName = deptRepo(slug, dept.id);
          try {
            const r = await ensureRepo({ name: repoName, private: true, description: `Crew department ${dept.id} — ${slug}` });
            results[`dept:${dept.id}`] = { repo: repoName, created: Boolean(r.id), html_url: r.html_url };
          } catch (e) {
            results[`dept:${dept.id}`] = { repo: repoName, error: e.message };
          }
        }
        return json(reply, 200, results);
      }

      throw new CrewError(`no route ${method} ${pathname}`, 404);
    }

    // ────────── static website (everything else) ──────────
    if (method === 'GET') {
      // strip leading slash, default to crew dashboard
      let rel = pathname === '/' ? 'crew-dashboard.html' : pathname.slice(1);
      // prevent directory traversal
      if (rel.includes('..')) throw new CrewError('bad path', 400);
      const filePath = join(STATIC_DIR, rel);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        return serveStatic(reply, filePath);
      }
      // fallback to dashboard for unknown routes
      const dash = join(STATIC_DIR, 'crew-dashboard.html');
      if (existsSync(dash)) return serveStatic(reply, dash);
      reply.writeHead(404, { 'Content-Type': 'text/plain' });
      reply.end('not found');
      return;
    }

    throw new CrewError(`no route ${method} ${pathname}`, 404);
  } catch (e) {
    err(reply, e);
  }
};

const server = createServer(handle);
server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`crew bus listening on :${PORT} (state: ${STATE_PATH})`);
  console.log(`static website from ${STATIC_DIR}`);
});
