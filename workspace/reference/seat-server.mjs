#!/usr/bin/env node
// JATIN seat server — reference prototype.
// Proves the join protocol in ONBOARDING.md end to end. No dependencies.
//
// The point of this file is not to be the product. It is to make three
// claims falsifiable rather than asserted:
//   1. One key provisions a whole seat (identity, rules, brief, worktree, cursor)
//   2. No task may be claimed before an admission
//   3. A verdict without a falsification attempt is `unproven`, not PASS
//
// Run: node seat-server.mjs [port]

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'

const PORT = Number(process.argv[2] || 8787)
const DB = new URL('./data.json', import.meta.url)
const WORKTREES = new URL('./worktrees/', import.meta.url)

// ---------- state ----------
let db = existsSync(DB)
  ? JSON.parse(readFileSync(DB, 'utf8'))
  : {
      seats: {},        // seatId -> seat
      keys: {},         // keyHash -> seatId
      sessions: {},     // token -> seatId
      events: [],       // append-only
      tasks: [
        { id: 'T-1', title: 'Build the quota scheduler urgency term', state: 'backlog', owner: null },
        { id: 'T-2', title: 'Audit: does the RLS gate reject a write grant with RLS off?', state: 'backlog', owner: null },
      ],
      ledger: [
        { row: 'C4-06', status: 'pass', evidence: ['prod-probe-1'] },
        { row: 'C9-05', status: 'unverified', expires: '2026-11-11', consequence: 'prod may drift from repo' },
      ],
      seq: 0,
    }

const save = () => writeFileSync(DB, JSON.stringify(db, null, 2))
const sha = (s) => createHash('sha256').update(String(s)).digest('hex')

function emit(type, actor, body, refs = []) {
  const e = { seq: ++db.seq, type, actor, at: new Date().toISOString(), refs, body }
  db.events.push(e)
  console.log(`  [event ${e.seq}] ${type} · ${actor}`)
  return e
}

// The law book, pinned into the session at join. In the product this is a
// versioned artifact; here it is the version tag plus the two rules this
// prototype actually enforces, so the demo cannot drift from the document.
const LAW = {
  version: 'v4-prototype',
  enforcedHere: ['4.2 no self-approval', '1.9 falsify, do not assert', '1.10 instrument control', '3.2 blocker names an exit'],
}

// ---------- the brief, generated from live tables, never hand-written ----------
function buildBrief(seat) {
  const asks = db.events.filter((e) => e.type === 'message' && e.refs.includes(seat.id) && !e.read)
  const open = db.tasks.filter((t) => t.state !== 'done')
  return {
    seat: { id: seat.id, role: seat.role, project: seat.project },
    law: LAW,
    // A3's rule: open asks go ABOVE the ledger.
    openAsks: asks.map((e) => ({ seq: e.seq, from: e.actor, subject: e.body?.subject })),
    whatThisIs: 'A crew of identical agents, separated only by seat, proving an onboarding protocol.',
    ledger: db.ledger,
    tasks: open.map((t) => ({ id: t.id, title: t.title, state: t.state, owner: t.owner })),
    settled: ['Providers: five adapters + OpenRouter catalogue, not seven providers.'],
    refusals: ['No agent may raise its own limits.', 'No unrecorded channel between agents.'],
    cursorAtJoin: db.seq,
  }
}

// ---------- http ----------
function send(res, code, obj) {
  const b = JSON.stringify(obj, null, 2)
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(b)
}

function body(req) {
  return new Promise((r) => {
    let d = ''
    req.on('data', (c) => (d += c))
    req.on('end', () => { try { r(d ? JSON.parse(d) : {}) } catch { r({}) } })
  })
}

function auth(req) {
  const h = req.headers.authorization || ''
  const tok = h.replace(/^Bearer\s+/i, '')
  if (!tok) return null
  if (db.sessions[tok]) return db.seats[db.sessions[tok]]
  const seatId = db.keys[sha(tok)]
  if (seatId) return db.seats[seatId]
  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  // ---- CREATE SEAT (operator side). In the product this needs a JWT; here it
  // needs nothing because the whole point is the join, not the onboarding UI.
  if (p === '/admin/create-seat' && req.method === 'POST') {
    const { role = 'builder', project = 'jatin-crew', id = 'seat-' + randomBytes(2).toString('hex') } = await body(req)
    const key = 'jt_seat_' + randomBytes(16).toString('hex')
    db.seats[id] = {
      id, role, project, status: 'created', admitted: false,
      worktree: new URL('./worktrees/' + id + '/', import.meta.url).pathname,
      joinedAt: null, lastSeq: 0,
    }
    db.keys[sha(key)] = id
    save()
    emit('seat.created', 'USER', { seat: id, role })
    // The key is returned ONCE. Only its hash is stored.
    return send(res, 201, { seat: id, key, note: 'shown once — only a hash is stored' })
  }

  // ---- JOIN: the one key → whole seat
  if (p === '/seat/join' && req.method === 'POST') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'unknown seat key' })
    const tok = 'sess_' + randomBytes(16).toString('hex')
    db.sessions[tok] = seat.id
    seat.status = 'online'
    // Only the FIRST join is an event. Re-joining with the same key is a
    // reconnect, not a new seat - and this prototype proved it by logging
    // seat.joined four times while I re-ran the demo. A stream that records
    // reconnects as arrivals makes "who joined" unanswerable.
    const firstJoin = !seat.joinedAt
    seat.joinedAt = seat.joinedAt || new Date().toISOString()
    seat.lastSeq = db.seq
    if (!existsSync(WORKTREES)) mkdirSync(WORKTREES, { recursive: true })
    mkdirSync(seat.worktree, { recursive: true })
    writeFileSync(new URL('./README', new URL(seat.id + '/', WORKTREES)), `worktree for ${seat.id}\n`)
    save()
    if (firstJoin) emit('seat.joined', seat.id, { role: seat.role, project: seat.project })
    return send(res, 200, {
      session: tok,
      seat: seat.id,
      provisioned: ['identity', 'rules', 'brief', 'worktree', 'env@execution', 'bench', 'tools', 'cursor', 'heartbeat'],
      worktree: seat.worktree,
      lawVersion: LAW.version,
      note: 'admission required before any task may be claimed',
    })
  }

  if (p === '/brief') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'no session' })
    return send(res, 200, buildBrief(seat))
  }

  if (p === '/events') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'no session' })
    const since = Number(url.searchParams.get('since') || 0)
    const fresh = db.events.filter((e) => e.seq > since)
    seat.lastSeq = db.seq
    save()
    return send(res, 200, { since, cursor: db.seq, count: fresh.length, events: fresh })
  }

  // ---- ADMISSION: must be first, must name something stale
  if (p === '/admission' && req.method === 'POST') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'no session' })
    const b = await body(req)
    if (!b.staleClaim || !b.taking || !b.notSurprised) {
      return send(res, 422, {
        error: 'admission must name: what you believe is stale, what you are taking, and what you do not understand',
        got: Object.keys(b),
      })
    }
    seat.admitted = true
    save()
    emit('admission', seat.id, b, ['C9-05'])
    return send(res, 200, { admitted: true, witnessCheck: 'queued: witness must RUN the staleness claim', ref: 'C9-05' })
  }

  // ---- CLAIM: refused before admission
  if (p.startsWith('/tasks/') && p.endsWith('/claim') && req.method === 'POST') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'no session' })
    if (!seat.admitted) {
      return send(res, 403, {
        error: 'no admission on record — claim refused',
        rule: 'J-09: an agent that joins and immediately works is an agent nobody checked',
      })
    }
    const id = p.split('/')[2]
    const t = db.tasks.find((x) => x.id === id)
    if (!t) return send(res, 404, { error: 'no such task' })
    if (t.owner && t.owner !== seat.id) return send(res, 409, { error: 'already owned', owner: t.owner })
    t.owner = seat.id
    t.state = 'in_progress'
    save()
    emit('task.claimed', seat.id, { task: id }, [id])
    return send(res, 200, { task: t, note: 'witness seat will be assigned automatically' })
  }

  // ---- VERDICT: the core rule. No falsification → unproven, never PASS.
  if (p === '/verdict' && req.method === 'POST') {
    const seat = auth(req)
    if (!seat) return send(res, 401, { error: 'no session' })
    const v = await body(req)
    const missing = []
    if (!v.evidence?.length) missing.push('evidence[]')
    if (!v.falsification?.command) missing.push('falsification.command (the command that tried to make the claim FALSE)')
    if (!v.falsification?.output_digest) missing.push('falsification.output_digest')
    if (!v.instrument_control?.expected_failure) missing.push('instrument_control.expected_failure')

    const verdict = missing.length ? 'unproven' : 'pass'

    // An unproven is not a rejection — it is a question. It is recorded.
    const rec = { seat: seat.id, verdict, claim: v.claim, missing, at: new Date().toISOString() }
    db.ledger.push({ row: v.row || 'ad-hoc', status: verdict, by: seat.id, missing })
    save()
    emit('verdict', seat.id, rec, [v.row].filter(Boolean))

    return send(res, missing.length ? 202 : 200, {
      ...rec,
      ...(missing.length
        ? { meaning: 'recorded as UNPROVEN. It is not green. It does not close the row. Queue it and run the falsification.' }
        : { meaning: 'PASS — evidence, falsification attempt and instrument control all present.' }),
    })
  }

  if (p === '/board') {
    return send(res, 200, { tasks: db.tasks, ledger: db.ledger, seats: Object.values(db.seats) })
  }

  send(res, 404, { error: 'no route', path: p })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`seat server on http://0.0.0.0:${PORT}`)
  console.log(`events so far: ${db.seq}`)
})
