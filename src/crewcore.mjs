// THE CREW — the thing the whole conversation has been circling.
//
// Eleven things a crew needs, and one decision that shapes all of them:
//
//   there is no server. The PC is the host and it goes off. So every
//   project is a file in the repository, and every rule below is applied
//   to that file rather than to a database that would lose itself.
//
// The eleven:
//   1. create a project                createProject
//   2. projects have departments       addDepartment
//   3. departments have agents, and every agent is a WORKER or an AUDITOR
//   4. departments talk to each other THROUGH HC, but agents anywhere may
//      talk to each other freely — those are two different channels and the
//      difference is enforced, not suggested
//   5. anyone may suggest anything, about anything
//   6. every project has one universal env
//   7. agents take secrets FROM that env, and every read is recorded
//   8. the operator can read every message, always
//   9. agents attach docs, rules, readmes — versioned, never overwritten
//  10. onboarding is a thing a seat does, not a briefing someone gives
//  11. onboarding is one call and it tells you exactly what to do next
//
// Everything here is pure: it takes a state object and returns a new one.
// Persistence is somebody else's job (see store.mjs), because a domain that
// knows about the filesystem cannot be tested without one.

import { randomBytes, createHash } from 'node:crypto';

export class CrewError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
  }
}

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const id = (p) => `${p}_${randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

export const KINDS = ['worker', 'auditor'];

// ── 1. a project ───────────────────────────────────────────────────────────
export function createProject(state, { slug, name, by = 'operator' }, clock = now) {
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    throw new CrewError('slug must be lowercase letters, digits and dashes');
  }
  if (state.projects.some((p) => p.slug === slug)) throw new CrewError(`project ${slug} already exists`, 409);

  const project = {
    slug,
    name: name || slug,
    createdAt: clock(),
    createdBy: by,
    departments: [],
    seats: [],       // { id, dept, kind, keyHash, admittedAt, ... }
    messages: [],    // the append-only bus
    suggestions: [],
    docs: [],
    env: [],         // { name, valueHash, value, updatedAt, updatedBy, reads: n }
    seq: 0,
  };
  state.projects.push(project);
  return project;
}

function projectOf(state, slug) {
  const p = state.projects.find((x) => x.slug === slug);
  if (!p) throw new CrewError(`no project ${slug}`, 404);
  return p;
}

// ── 2. departments, and the council that connects them ─────────────────────
// Every department is connected to HC by exactly one liaison. Without one it
// is cut off, and a cut-off department cannot be talked to or talk.
export function addDepartment(project, { id: deptId, name, liaison, clock = now }) {
  if (!deptId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(deptId)) throw new CrewError('bad department id');
  if (project.departments.some((d) => d.id === deptId)) throw new CrewError(`department ${deptId} exists`, 409);

  // a liaison must already be a seat on the council department, if there is one
  if (project.departments.length > 0) {
    if (!liaison) throw new CrewError(`department ${deptId} needs an HC liaison — otherwise it is cut off`);
    const l = project.seats.find((s) => s.id === liaison);
    if (!l) throw new CrewError(`liaison ${liaison} is not a seat in this project`);
    if (l.dept !== 'hc') throw new CrewError(`liaison ${liaison} is in ${l.dept}, not hc`);
  }

  const dept = { id: deptId, name: name || deptId, liaison: liaison ?? null, createdAt: clock(), createdVia: 'manual' };
  project.departments.push(dept);
  return dept;
}

// ── 3. agents: a worker or an auditor, never both ──────────────────────────
export function addSeat(project, { id: seatId, dept, kind, createdBy = 'operator' }, clock = now) {
  if (!seatId || !/^[a-z0-9][a-z0-9-]{0,30}$/i.test(seatId)) throw new CrewError('bad seat id');
  if (project.seats.some((s) => s.id === seatId)) throw new CrewError(`seat ${seatId} exists`, 409);
  if (!KINDS.includes(kind)) throw new CrewError(`a seat is ${KINDS.join(' or ')} — got ${kind}`);

  const d = project.departments.find((x) => x.id === dept);
  if (!d) throw new CrewError(`no department ${dept}`);

  // The rule that survived every earlier version of this project: the entity
  // that builds may not be the entity that judges. One key, one kind.
  const key = `ab_${randomBytes(18).toString('base64url')}`;
  const seat = {
    id: seatId,
    dept,
    kind,
    keyHash: sha(key),
    createdAt: clock(),
    createdBy,
    admittedAt: null,
    lastSeen: null,
    docsRead: [],
  };
  project.seats.push(seat);
  return { seat, key }; // the key is returned once and never stored in the clear
}

export function seatFromKey(project, key) {
  const h = sha(String(key));
  return project.seats.find((s) => s.keyHash === h) ?? null;
}

// ── 4. two channels, and the difference is enforced ────────────────────────
//
//   chat      free and open. Any agent may talk to any other agent, about
//             anything, in any department. Talk is not authority.
//   official  crosses a department boundary, so it is routed: it leaves from
//             the sender's department auditor and arrives through the
//             receiver's HC liaison. Both must be named in `via`.
//
// The point is not to stop people talking. It is to stop a decision being
// mistaken for a conversation.
export const MESSAGE_TYPES = ['chat', 'official', 'question', 'answer', 'suggestion', 'presence', 'system'];

export function postMessage(project, seat, { type = 'chat', text, to = null, via = [], refs = null }, clock = now) {
  if (!MESSAGE_TYPES.includes(type)) throw new CrewError(`unknown message type ${type}`);
  if (!text || !String(text).trim()) throw new CrewError('an empty message is not a message');
  if (!seat.admittedAt) throw new CrewError('admit yourself before speaking — see /brief', 403);

  const dept = project.departments.find((d) => d.id === seat.dept);
  if (!dept) throw new CrewError(`seat ${seat.id} is in an unknown department`);

  let route = [];
  if (type === 'official') {
    if (!to) throw new CrewError('an official message names who it is for');
    const target = project.seats.find((s) => s.id === to);
    if (!target) throw new CrewError(`no seat ${to}`);
    if (target.dept !== seat.dept) {
      const fromAuditor = project.seats.find((s) => s.dept === seat.dept && s.kind === 'auditor');
      const targetDept = project.departments.find((d) => d.id === target.dept);
      const liaison = targetDept?.liaison ? project.seats.find((s) => s.id === targetDept.liaison) : null;
      const need = [fromAuditor?.id, liaison?.id].filter(Boolean);
      const missing = need.filter((x) => !via.includes(x));
      if (missing.length) {
        throw new CrewError(
          `${seat.dept} → ${target.dept} crosses a boundary and must be relayed. missing: ${missing.join(', ')}. ` +
            `accepted path: ${[seat.id, ...need, target.id].join(' → ')}`,
          422,
        );
      }
      route = [seat.id, ...need, target.id];
    } else {
      route = [seat.id, target.id];
    }
  }

  const msg = {
    seq: ++project.seq,
    at: clock(),
    from: seat.id,
    dept: seat.dept,
    kind: seat.kind,
    type,
    text: String(text).slice(0, 8000),
    to,
    via,
    route,
    refs,
  };
  project.messages.push(msg);
  return msg;
}

// ── 5. anyone may suggest anything ─────────────────────────────────────────
export function suggest(project, seat, { text, about = null }, clock = now) {
  if (!String(text || '').trim()) throw new CrewError('a suggestion needs words');
  const s = {
    id: id('sg'),
    at: clock(),
    from: seat?.id ?? 'operator',
    dept: seat?.dept ?? 'hc',
    text: String(text).slice(0, 4000),
    about,
    status: 'open',
  };
  project.suggestions.push(s);
  // and it goes on the bus, because a suggestion nobody sees is a diary entry
  postMessage(project, seat ?? { id: 'operator', dept: 'hc', kind: 'auditor', admittedAt: 'x' }, {
    type: 'suggestion',
    text: s.text,
    refs: { suggestion: s.id },
  }, clock);
  return s;
}

// ── 6 & 7. one env per project, and agents take from it ────────────────────
//
// The operator writes; agents read. Every read is counted and attributed,
// because an env that agents can silently drain is not an env, it is a leak.
export function setEnv(project, { name, value, by = 'operator' }, clock = now) {
  if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(name)) throw new CrewError('env names are UPPER_SNAKE, like REPO_TOKEN');
  if (typeof value !== 'string' || !value.length) throw new CrewError('an env value cannot be empty');
  const existing = project.env.find((e) => e.name === name);
  const record = { name, value, valueHash: sha(value), updatedAt: clock(), updatedBy: by, reads: existing?.reads ?? 0 };
  if (existing) Object.assign(existing, record);
  else project.env.push(record);
  return { name, updatedAt: record.updatedAt, updatedBy: by };
}

// reading is the whole point, so it is a first-class, audited operation
export function readEnv(project, seat, { names = null } = {}, clock = now) {
  if (!seat.admittedAt) throw new CrewError('admit yourself before reading the env', 403);
  const picked = names ? project.env.filter((e) => names.includes(e.name)) : project.env;
  if (names) {
    const missing = names.filter((n) => !project.env.some((e) => e.name === n));
    if (missing.length) throw new CrewError(`no such env var: ${missing.join(', ')}`, 404);
  }
  for (const e of picked) {
    e.reads = (e.reads ?? 0) + 1;
    e.lastReadBy = e.lastReadBy ?? [];
    e.lastReadBy.push({ seat: seat.id, at: clock() });
    e.lastReadBy = e.lastReadBy.slice(-20);
  }
  project.messages.push({
    seq: ++project.seq,
    at: clock(),
    from: seat.id,
    dept: seat.dept,
    kind: seat.kind,
    type: 'system',
    text: `read env: ${picked.map((e) => e.name).join(', ') || '(nothing)'}`,
    to: null,
    via: [],
    route: [],
    refs: { env: picked.map((e) => e.name) },
  });
  return Object.fromEntries(picked.map((e) => [e.name, e.value]));
}

// ── 8. the operator reads everything ───────────────────────────────────────
export function transcript(project, { since = 0, limit = 200, dept = null } = {}) {
  return project.messages
    .filter((m) => m.seq > since)
    .filter((m) => !dept || m.dept === dept)
    .slice(0, limit);
}

// ── 9. docs: rules, readmes, specs — versioned, never overwritten ──────────
export function addDoc(project, seat, { slug, title, body, kind = 'doc' }, clock = now) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(slug || '')) throw new CrewError('doc slug is lowercase-dashed');
  if (!String(body || '').trim()) throw new CrewError('a doc with no body is a title');
  const versions = project.docs.filter((d) => d.slug === slug);
  const v = versions.length + 1;
  const doc = {
    slug,
    version: v,
    title: title || slug,
    kind, // doc | rules | readme | spec | attachment
    body: String(body).slice(0, 200_000),
    at: clock(),
    by: seat?.id ?? 'operator',
    dept: seat?.dept ?? 'hc',
    supersedes: versions.length ? versions[versions.length - 1].version : null,
  };
  project.docs.push(doc);
  return { slug, version: v, title: doc.title, kind };
}

export function readDoc(project, slug, version = null) {
  const all = project.docs.filter((d) => d.slug === slug);
  if (!all.length) throw new CrewError(`no doc ${slug}`, 404);
  return version ? all.find((d) => d.version === version) ?? all.at(-1) : all.at(-1);
}

// ── 10 & 11. onboarding: one call, and it says what to do next ─────────────
//
// The failure this exists to prevent: an agent joins, reads nothing, and
// starts confidently wrong. So admission is explicit, and the brief it
// returns is ordered — what you are, what to read, what to do, what not to.
export function admit(project, seat, { takes = '', stale = '', doesNotUnderstand = '' }, clock = now) {
  if (seat.admittedAt) return { already: true, at: seat.admittedAt };
  if (!takes.trim() || !doesNotUnderstand.trim()) {
    throw new CrewError('admission needs what you take and what you do not understand — that is the point of it', 422);
  }
  seat.admittedAt = clock();
  project.messages.push({
    seq: ++project.seq,
    at: seat.admittedAt,
    from: seat.id,
    dept: seat.dept,
    kind: seat.kind,
    type: 'presence',
    text: `admitted. takes: ${takes}. stale: ${stale || 'nothing declared'}. does not understand: ${doesNotUnderstand}`,
    to: null,
    via: [],
    route: [],
    refs: null,
  });
  return { already: false, at: seat.admittedAt };
}

export function brief(project, seat, clock = now) {
  seat.lastSeen = clock();
  const dept = project.departments.find((d) => d.id === seat.dept);
  const peers = project.seats.filter((s) => s.dept === seat.dept && s.id !== seat.id);
  const docs = [...new Set(project.docs.map((d) => d.slug))].map((s) => {
    const latest = readDoc(project, s);
    return { slug: s, version: latest.version, title: latest.title, kind: latest.kind };
  });
  const since = seat.admittedAt ? project.messages.filter((m) => m.at > (seat.lastSeenBefore ?? '')).length : 0;

  return {
    you: {
      id: seat.id,
      kind: seat.kind,
      department: seat.dept,
      departmentName: dept?.name,
      admitted: Boolean(seat.admittedAt),
    },
    // what an auditor or worker is for — different answers, because they are
    // different jobs and one of them must never build
    yourJob:
      seat.kind === 'auditor'
        ? 'You judge work you did not write. Read the actual diff and the actual output, never a summary of them. If it fails, send it back with the exact command that fails. Your name is on what you pass.'
        : 'You build. Claim one thing at a time, work on your own branch, and do not mark your own work done — an auditor does that, and only after reading it.',
    yourDepartment: {
      id: dept?.id,
      liaison: dept?.liaison ?? null,
      peers: peers.map((p) => ({ id: p.id, kind: p.kind })),
    },
    readThese: docs,
    env: project.env.map((e) => e.name), // names only; values come from readEnv, on the record
    recent: project.messages.slice(-10).map((m) => ({ seq: m.seq, from: m.from, type: m.type, text: m.text.slice(0, 200) })),
    nextStep: !seat.admittedAt
      ? 'Admit yourself: POST /admit with what you take and what you do not understand. Nothing else works until you do.'
      : project.messages.length === 0
        ? 'The bus is empty. Say hello and state what you intend to do.'
        : `Read the last ${Math.min(10, project.messages.length)} messages, then post one line saying what you are taking.`,
    rules: [
      'A worker builds. An auditor judges. No seat is both — the key you hold is one or the other.',
      'Anything you say is permanent and readable by the operator. There is no private channel.',
      'Cross-department decisions go through HC: name your department auditor and the receiver’s liaison in `via`.',
      'Free conversation is free. Talk to anyone, about anything — talk is not authority.',
      'Secrets come from the project env through readEnv. Every read is recorded against your seat.',
    ],
    counts: { depts: project.departments.length, seats: project.seats.length, messages: project.messages.length, docs: docs.length },
    unseen: Number(since) || 0,
  };
}

export function newState() {
  return { version: 1, projects: [] };
}
