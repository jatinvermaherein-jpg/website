#!/usr/bin/env node
// THE BRAIN — a seat that reasons.
//
// Everything up to now was rails: seat-agent.mjs runs a command you give it.
// This is different. This seat is given a JOB, a set of TOOLS, and a model,
// and it decides for itself what to do — read the board, claim work, talk to
// the other seats, run commands, submit for witness, hand over.
//
// It is a real agent loop, not a script:
//
//   brief → think → call a tool → observe → think again → … → hand over
//
// The model can be anything that speaks the OpenAI chat-completions shape.
// Two ways to point it at one:
//
//   A. the JATIN gateway (pooled, capped, audited, attributed to the seat)
//        JATIN_MODEL=groq/llama-3.3-70b-versatile
//        JATIN_MODEL_KEY=<gateway key jkn_…>
//        (default base = $JATIN_API_BASE/api/flow)
//
//   B. a provider directly — groq, openai, together, ollama, anything
//        JATIN_MODEL=llama-3.3-70b-versatile
//        JATIN_MODEL_BASE=https://api.groq.com/openai/v1
//        JATIN_MODEL_KEY=gsk_…
//
// Nothing here is privileged. Every action goes through the same HTTP API a
// human or any other agent uses, so the audit trail is identical.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const runFile = promisify(execFile);

const API = (process.env.JATIN_API_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PROJECT = process.env.JATIN_PROJECT || '';
const KEY = process.env.JATIN_SEAT_KEY || process.env.JATIN_SEAT_TOKEN || '';

const MODEL = process.env.JATIN_MODEL || 'llama-3.3-70b-versatile';
const MODEL_BASE = (process.env.JATIN_MODEL_BASE || `${API}/api/flow`).replace(/\/$/, '');
const MODEL_KEY = process.env.JATIN_MODEL_KEY || KEY;
const TEMPERATURE = Number(process.env.JATIN_TEMPERATURE ?? 0.3);
const MAX_STEPS = Number(process.env.JATIN_MAX_STEPS ?? 24);
const ALLOW_SHELL = process.env.JATIN_ALLOW_SHELL === '1';
const WORKDIR = process.env.JATIN_WORKDIR || process.cwd();
const POLL_MS = Number(process.env.JATIN_POLL_MS || 2500);

if (!PROJECT || !KEY) {
  console.error('brain: JATIN_PROJECT and JATIN_SEAT_KEY are required');
  process.exit(2);
}

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the project API, exactly as any other client would call it ─────────────
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

// ── the model ──────────────────────────────────────────────────────────────
const MAX_MODEL_TRIES = Number(process.env.JATIN_MODEL_TRIES ?? 8);

// Models are not always available. A rate limit is not a failure — it is an
// instruction with a number in it. Wait the number, then continue: a seat that
// dies on the first 429 is a seat that cannot be left running.
async function chat(messages, tools) {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_MODEL_TRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${MODEL_BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${MODEL_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: TEMPERATURE }),
      });
    } catch (e) {
      lastError = `network: ${e.message}`;
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();

    // 429 / 402 / 503 — read the retry hint if the endpoint gave one
    if (res.status === 429 || res.status === 402 || res.status >= 500) {
      let wait = 5000 * attempt;
      try {
        const body = JSON.parse(text);
        const hint = Number(body?.error?.retry_after ?? body?.retry_after_s ?? body?.retry_after);
        const m = String(body?.error?.message || '').match(/retry after (\d+)/i);
        if (Number.isFinite(hint) && hint > 0) wait = hint * 1000;
        else if (m) wait = Number(m[1]) * 1000;
        else if (/every (\d+) seconds/i.test(String(body?.error?.message))) {
          wait = Number(String(body.error.message).match(/every (\d+) seconds/i)[1]) * 1000;
        }
      } catch {
        /* not json — fall back to the backoff */
      }
      log(`model busy (${res.status}) — waiting ${Math.round(wait / 1000)}s (try ${attempt}/${MAX_MODEL_TRIES})`);
      await sleep(wait + 500);
      lastError = `${res.status}: ${text.slice(0, 200)}`;
      continue;
    }

    if (!res.ok) throw new Error(`model ${res.status}: ${text.slice(0, 400)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      lastError = `unparseable body: ${text.slice(0, 200)}`;
      await sleep(2000 * attempt);
      continue;
    }
    const choice = data?.choices?.[0];
    if (!choice) {
      lastError = `no choice: ${text.slice(0, 300)}`;
      await sleep(2000 * attempt);
      continue;
    }
    return choice.message;
  }
  throw new Error(`model unavailable after ${MAX_MODEL_TRIES} tries — ${lastError}`);
}

// Some OpenAI-compatible endpoints leak their internal chat format into the
// function name — gpt-oss through Pollinations emits `post<|channel|>commentary`.
// The tool is obviously `post`. Strip the control tokens rather than failing a
// turn over a formatting artefact of somebody else's server.
function cleanToolName(name) {
  if (typeof name !== 'string') return '';
  return name.split('<|')[0].replace(/[^a-zA-Z0-9_]/g, '').trim();
}

// and the same tokens in a message we send BACK will be rejected upstream
// ("unexpected tokens remaining in message header"), so scrub our own history
function scrub(text) {
  return typeof text === 'string' ? text.replace(/<\|[^|>]*\|>/g, '').trim() : text;
}

// Different models wrap tool arguments differently. gpt-oss on Pollinations
// returns {"input": {"taskId": "..."}}, which is not the schema and would be
// passed straight through as junk. Unwrap the wrapper, never guess the rest.
function toolArgs(raw, toolName) {
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    return {};
  }
  if (args && typeof args === 'object' && Object.keys(args).length === 1 && args.input && typeof args.input === 'object') {
    const schema = TOOLS.find((t) => t.function.name === toolName)?.function.parameters || {};
    const props = Object.keys(schema.properties || {});
    // only unwrap when the wrapper key is not itself a real parameter
    if (!props.includes('input')) args = args.input;
  }
  return args;
}

// ── tools: the seat's actual reach ─────────────────────────────────────────
// Deliberately the SAME surface the MCP client exposes, plus a shell for
// seats that are given one. A tool the model cannot see is a capability the
// agent does not have.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_brief',
      description: 'Re-read the project brief: my role, the rules, the board, what is waiting in my inbox, my next step.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_inbox',
      description: 'What other seats said to me, and replies to things I wrote.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post',
      description: 'Say something on the project bus. Use to: to address a seat; replyTo to answer a specific line.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          to: { type: 'string', description: 'seat name, or omit' },
          replyTo: { type: 'string', description: 'seq of the line being answered' },
          type: { type: 'string', enum: ['message', 'answer', 'correction'] },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'The board: what exists, its status, owner and witness.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_task',
      description: 'Take a task from the backlog. One owner; the first claim wins. Only the owner can submit it.',
      parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_task',
      description: 'Hand a claimed task to review for witness. Only the owner. Say what you did.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          summary: { type: 'string' },
          artifacts: {
            type: 'array',
            items: { type: 'object', properties: { commit: { type: 'string' }, path: { type: 'string' }, contentHash: { type: 'string' } }, required: ['commit', 'path', 'contentHash'] },
          },
        },
        required: ['taskId', 'summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'witness_task',
      description:
        'As an auditor: rule on a task somebody else submitted. A pass needs BOTH a falsification attempt and an instrument control, or the verdict is demoted to unproven and the task stays in review.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          reason: { type: 'string' },
          falsification: { type: 'object', properties: { command: { type: 'string' }, output_digest: { type: 'string' } }, required: ['command', 'output_digest'] },
          instrumentControl: { type: 'object', properties: { command: { type: 'string' }, output_digest: { type: 'string' }, expected_failure: { type: 'string' } }, required: ['command', 'output_digest', 'expected_failure'] },
        },
        required: ['taskId', 'verdict', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: 'Read a project document by slug — rules, specs, attachments.',
      parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_env',
      description: 'The project environment values the operator opened to seats, plus the names it did not open.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
];

if (ALLOW_SHELL) {
  TOOLS.push({
    type: 'function',
    function: {
      name: 'run_command',
      description: `Run a shell command in ${WORKDIR} and get its output. Use it to actually check things — tests, builds, greps. Do not guess at output you could observe.`,
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  });
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `… (${s.length - n} more)` : s);
const rid = (x) => (x == null ? x : typeof x === 'object' ? rid(x.id ?? x.seq ?? x.slug) : String(x));

async function execute(name, args) {
  switch (name) {
    case 'read_brief': {
      const r = await api('GET', `/api/projects/${PROJECT}/brief`);
      return r.ok ? r.data : { error: r.data };
    }
    case 'read_inbox': {
      const r = await api('GET', `/api/projects/${PROJECT}/inbox`);
      return r.ok ? r.data : { error: r.data };
    }
    case 'post': {
      const r = await api('POST', `/api/projects/${PROJECT}/stream`, {
        type: args.type || 'message',
        body: args.to ? { text: args.text, to: args.to } : { text: args.text },
        ...(args.replyTo ? { refs: { replyTo: String(args.replyTo) } } : {}),
      });
      return r.ok ? { posted: true, seq: rid(r.data) } : { error: r.data };
    }
    case 'list_tasks': {
      const r = await api('GET', `/api/projects/${PROJECT}/tasks`);
      return r.ok ? { counts: r.data.counts, tasks: (r.data.tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, witness: t.witness, acceptance: t.acceptance })) } : { error: r.data };
    }
    case 'claim_task': {
      const r = await api('POST', `/api/projects/${PROJECT}/tasks/${args.taskId}/claim`);
      return r.ok ? r.data : { error: r.data };
    }
    case 'submit_task': {
      const r = await api('POST', `/api/projects/${PROJECT}/tasks/${args.taskId}/submit`, { summary: args.summary, artifacts: args.artifacts || [] });
      return r.ok ? r.data : { error: r.data };
    }
    case 'witness_task': {
      const r = await api('POST', `/api/projects/${PROJECT}/tasks/${args.taskId}/witness`, {
        verdict: args.verdict,
        reason: args.reason,
        ...(args.falsification ? { falsification: args.falsification } : {}),
        ...(args.instrumentControl ? { instrumentControl: args.instrumentControl } : {}),
      });
      return r.ok ? r.data : { error: r.data };
    }
    case 'read_doc': {
      const r = await api('GET', `/api/projects/${PROJECT}/docs/${encodeURIComponent(args.slug)}`);
      return r.ok ? { slug: r.data.slug, version: r.data.version, body: clip(r.data.body, 6000) } : { error: r.data };
    }
    case 'read_env': {
      const r = await api('GET', `/api/projects/${PROJECT}/env/values`);
      return r.ok ? r.data : { error: r.data };
    }
    case 'run_command': {
      if (!ALLOW_SHELL) return { error: 'this seat was not given a shell' };
      try {
        const { stdout, stderr } = await runFile('sh', ['-c', args.command], { cwd: WORKDIR, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
        const out = (stdout || '') + (stderr || '');
        return {
          exit: 0,
          output: clip(out, 6000),
          sha256: createHash('sha256').update(out).digest('hex'),
        };
      } catch (e) {
        const err = e;
        const out = String(err.stdout || '') + String(err.stderr || '') + String(err.message || '');
        return { exit: typeof err.code === 'number' ? err.code : 1, output: clip(out, 6000), sha256: createHash('sha256').update(out).digest('hex') };
      }
    }
    default:
      return { error: `no such tool: ${name}` };
  }
}

// ── the prompt ─────────────────────────────────────────────────────────────
function systemPrompt(brief, role) {
  const board = brief?.board || {};
  const team = (brief?.team || []).map((s) => `${s.name}(${s.role})`).join(', ');
  return [
    `You are ${role.name}, a ${role.role} seat on the project "${brief?.project?.slug}" of a crew that does audited work.`,
    `You are one of a team of agents. The others: ${team}. You talk to them on the project bus. You are not alone and you are not the whole crew.`,
    '',
    'HOW THIS CREW WORKS',
    '- Work lives on a board. backlog → claim → in_progress → submit → review → witness → done.',
    '- Only an AUDITOR can witness. A witness is never the owner. A pass needs BOTH a falsification attempt and an instrument control.',
    '- Unproven is a real answer. If you cannot prove it, say so and leave the task in review.',
    '- Everything you say or do is on an append-only, totally ordered bus. It is the record.',
    '',
    `WHERE THE WORK IS RIGHT NOW`,
    `  backlog: ${board.counts?.backlog ?? 0} · in progress: ${board.counts?.in_progress ?? 0} · review: ${board.counts?.review ?? 0} · done: ${board.counts?.done ?? 0}`,
    `  claimable: ${JSON.stringify((board.claimable || []).map((t) => ({ id: t.id, title: t.title })))}`,
    `  awaiting a witness: ${JSON.stringify((board.witnessable || []).map((t) => ({ id: t.id, title: t.title })))}`,
    `  mine: ${JSON.stringify((board.mine || []).map((t) => ({ id: t.id, title: t.title })))}`,
    `  awaiting someone else's witness: ${JSON.stringify((board.awaitingWitness || []).map((t) => ({ id: t.id, title: t.title })))}`,
    '',
    `YOUR ROLE: ${role.role}.`,
    role.role === 'auditor'
      ? 'You audit. You do not build. Look at what others submitted, actually try to break it, and rule. If you cannot falsify something, it is not because it is perfect.'
      : role.role === 'lead'
        ? 'You direct. You do not close work — a lead cannot witness. Notice what is stuck, say what matters, keep the crew pointed at the goal.'
        : 'You build. Claim work, do it with the tools you have, run the checks that prove it works, then submit with an honest summary.',
    '',
    'BEHAVIOUR',
    '- Do not narrate. Act. Use tools.',
    '- Before claiming a task, read the board. Before submitting, know what you actually did.',
    '- Talk to the others when it matters — a question, a correction, a hand-over. Not chatter.',
    '- When you have nothing useful left to do this turn, call finish with what you did and what is next.',
    '',
    brief?.rules ? `THE RULES DOCUMENT is "${brief.rules.slug}" v${brief.rules.version} — read it with read_doc if you have not.` : '',
    process.env.JATIN_GOAL ? `\nTHE GOAL FROM THE OPERATOR: ${process.env.JATIN_GOAL}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── a turn ─────────────────────────────────────────────────────────────────
// One turn = think until the model is done. A SEAT is a turn loop: it stays on
// the project and starts a new turn when something happens that concerns it.
// Without this, three agents started together simply miss each other — the
// auditor looks before the builder has submitted, finds nothing, and leaves.
// That is not a team, it is three scripts that ran once.
async function oneTurn(briefData, role, goal) {
  const messages = [
    { role: 'system', content: systemPrompt(briefData, role) },
    { role: 'user', content: goal || 'Look at the board and do what a ' + role.role + ' should do. If there is nothing, say so to the team and finish.' },
  ];

  let steps = 0;
  let finished = null;
  // a handover is for a change or a stop — not a heartbeat. Writing one per
  // turn produced 27 identical "I witnessed the ingest task" lines on the bus
  // and buried the one message that mattered.
  const actions = [];
  while (steps < MAX_STEPS) {
    steps += 1;
    let msg;
    try {
      msg = await chat(messages, TOOLS);
    } catch (e) {
      console.error(`brain: model call failed at step ${steps}: ${e.message}`);
      break;
    }
    // keep the history clean: an echoed control token is a 400 next turn
    const cleanMsg = {
      role: 'assistant',
      content: scrub(msg.content ?? null),
      ...(msg.tool_calls
        ? {
            tool_calls: msg.tool_calls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: cleanToolName(c.function?.name), arguments: c.function?.arguments || '{}' },
            })),
          }
        : {}),
    };
    messages.push(cleanMsg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      // the model answered in prose instead of acting — that is its finish
      finished = { said: String(msg.content || '').slice(0, 600) };
      log(`step ${steps}: no tool call — treating as done`);
      break;
    }

    for (const call of calls) {
      const name = cleanToolName(call.function?.name);
      const args = toolArgs(call.function?.arguments, name);
      if (name === 'finish') {
        finished = args;
        break;
      }
      const shown = JSON.stringify(args).slice(0, 140);
      log(`step ${steps}: ${name}(${shown})`);
      if (name === 'claim_task' || name === 'submit_task' || name === 'witness_task' || name === 'post') actions.push(name);
      let result;
      try {
        result = await execute(name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      const compact = clip(JSON.stringify(result), 2500);
      if (result && result.error) log(`   ↳ refused: ${JSON.stringify(result.error).slice(0, 200)}`);
      else log(`   ↳ ok`);
      messages.push({ role: 'tool', tool_call_id: call.id, content: compact });
    }
    if (finished) break;
  }

  return { steps, finished, actions };
}

// a seat remembers what it has already seen. Without this the inbox returns
// the same three messages every poll and the seat "wakes" forever — which is
// the metronome with better marketing, and the exact failure this whole
// design exists to avoid.
let seenSeq = 0;
let turnBudget = Number(process.env.JATIN_MAX_TURNS ?? 12);

// ── is there something for me to do? ──────────────────────────────────────
// The signal a seat watches. A builder wants claimable work. An auditor wants
// work in review. Everyone wants a message. Nothing else starts a turn — a
// seat that wakes for no reason is a metronome with better marketing.
async function whatIsWaiting(role) {
  const [b, inbox] = await Promise.all([
    api('GET', `/api/projects/${PROJECT}/brief`),
    api('GET', `/api/projects/${PROJECT}/inbox`),
  ]);
  if (!b.ok) return { reason: null };
  const board = b.data.board || {};
  // only lines I have not already read. seq is the total order, so a
  // high-water mark is exactly right.
  const messages = (inbox.ok ? inbox.data.messages || [] : []).filter((m) => Number(m.seq) > seenSeq);
  const head = inbox.ok ? Number(inbox.data.head || 0) : 0;
  if (messages.length) seenSeq = Math.max(seenSeq, ...messages.map((m) => Number(m.seq)));
  const claimable = (board.claimable || []).length;
  const witnessable = (board.witnessable || []).length;
  const mine = (board.mine || []).length;

  if (messages.length) return { reason: `${messages.length} new message(s)`, brief: b.data };
  void head;
  if (role.role === 'auditor' && witnessable > 0) return { reason: `${witnessable} task(s) awaiting witness`, brief: b.data };
  if (role.role === 'builder' && mine > 0) return { reason: 'my task is in progress', brief: b.data };
  if (role.role === 'builder' && claimable > 0) return { reason: `${claimable} claimable task(s)`, brief: b.data };
  return { reason: null, brief: b.data };
}

// ── the seat ───────────────────────────────────────────────────────────────
async function main() {
  let b = await api('GET', `/api/projects/${PROJECT}/brief`);
  if (!b.ok) {
    console.error(`brain: could not read the brief (${b.status}) ${JSON.stringify(b.data)}`);
    process.exit(1);
  }
  let me = b.data.me;
  const role = { name: me.name, role: me.role };
  log(`seat ${me.name} (${me.role}) on ${PROJECT} · model ${MODEL}`);

  // admission first — D3: no verdict, no task, before you say what you are
  if (!me.admitted) {
    const a = await api('POST', `/api/projects/${PROJECT}/stream`, {
      type: 'admission',
      body: {
        takes: `the ${me.role} seat — ${process.env.JATIN_GOAL ? clip(process.env.JATIN_GOAL, 120) : 'whatever the board needs'}`,
        stale: `${b.data.docs?.length ?? 0} document(s) indexed; ruleset ${b.data.project?.activeRulesetVersion ?? 'none'}`,
        doesNotUnderstand: 'what the other seats intend to do — I will ask them',
      },
    });
    if (!a.ok) {
      console.error(`brain: admission refused ${JSON.stringify(a.data)}`);
      process.exit(1);
    }
    log('admitted');
    b = await api('GET', `/api/projects/${PROJECT}/brief`);
    me = b.data.me;
  }

  const goal = process.env.JATIN_GOAL || '';
  const watch = process.env.JATIN_WATCH !== '0'; // a seat lives until told to stop
  let turns = 0;
  let stopping = false;
  let lastHandover = '';
  // did the most recent turn already put a handover on the bus? if so, the
  // "seat stopped" line is noise, not a record.
  let saidSomething = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    log('stop requested — finishing the current thought, then handing over');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  do {
    turns += 1;
    if (turns > turnBudget) {
      log(`turn budget of ${turnBudget} reached — standing down rather than spinning`);
      break;
    }
    log(`turn ${turns}/${turnBudget}${goal ? ` · goal: ${clip(goal, 60)}` : ''}`);
    const r = await oneTurn(b, role, goal);
    log(`turn ${turns} done — ${r.steps} step(s)`);

    // Hand over only when the turn CHANGED something. A seat that narrates
    // every empty turn buries the record it is supposed to be keeping.
    if (r.actions.length) {
      const line = {
        finished: clip(String(r.finished?.finished || r.finished?.said || `turn ${turns}: ${r.actions.join(', ')}`), 600),
        unfinished: clip(String(r.finished?.unfinished || 'whatever the board still shows'), 600),
        next: clip(String(r.finished?.next || 're-read the board and the bus'), 600),
      };
      const sig = JSON.stringify(line);
      if (sig !== lastHandover) {
        lastHandover = sig;
        await api('POST', `/api/projects/${PROJECT}/handover`, line).catch(() => {});
        saidSomething = true;
      }
    } else {
      saidSomething = false;
    }

    if (!watch || stopping) break;

    // wait for something that concerns ME — not a timer
    let waited = 0;
    let next = null;
    while (!stopping) {
      await sleep(POLL_MS);
      waited += POLL_MS;
      const w = await whatIsWaiting(role);
      b = w.brief || b;
      if (w.reason) {
        next = w.reason;
        break;
      }
      if (waited >= Number(process.env.JATIN_IDLE_MS || 180_000)) {
        log('nothing has concerned me for a while — standing down (this is not a failure)');
        break;
      }
    }
    if (!next) break;
    log(`woke: ${next}`);
  } while (!stopping);

  // On the way out, record where the seat left the work — but only if the last
  // turn did not already say it. A second identical line is not a record.
  if (!saidSomething) {
    const final = await api('POST', `/api/projects/${PROJECT}/handover`, {
      finished: `seat ${role.name} stopped after ${turns} turn(s)`,
      unfinished: 'whatever the board shows',
      next: 'read the board and the bus before acting — the state is there, not here',
    }).catch(() => ({ ok: false }));
    log(final.ok ? 'handover written · seat stopped' : 'seat stopped');
  } else {
    log('seat stopped (the last turn already recorded where things stand)');
  }
}

main().catch((e) => {
  console.error('brain: fatal', e);
  process.exit(1);
});
