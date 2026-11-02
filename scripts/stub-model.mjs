#!/usr/bin/env node
// A STUB MODEL — an OpenAI-shaped endpoint that plays a seat's policy.
//
// This is NOT intelligence and must never be presented as such. It is a test
// double: it speaks the chat-completions protocol so the real agent loop
// (scripts/seat-brain.mjs) is genuinely exercised end to end — real tool
// calls, real HTTP, real bus. Point the brain at a real model and nothing in
// the loop changes.
//
// The policy is a function of the conversation so far, exactly like a model
// would be — it looks at what tools already returned and decides the next
// call. One stub per role, chosen by the JATIN_STUB_ROLE env or the system
// prompt.
//
//   node scripts/stub-model.mjs            # listens on :8099
import { createServer } from 'node:http';

const PORT = Number(process.env.JATIN_STUB_PORT || 8099);

// what a tool result looked like, read back out of the message history
function results(messages) {
  return messages.filter((m) => m.role === 'tool').map((m) => {
    try {
      return JSON.parse(m.content.replace(/… \(\d+ more\)$/, ''));
    } catch {
      return { raw: m.content };
    }
  });
}

function callsSoFar(messages) {
  return messages
    .filter((m) => m.role === 'assistant' && m.tool_calls)
    .flatMap((m) => m.tool_calls.map((c) => c.function?.name))
    .filter(Boolean);
}

// the role is in the system prompt: "You are X, a Y seat"
function roleOf(messages) {
  const sys = messages.find((m) => m.role === 'system')?.content || '';
  const m = sys.match(/YOUR ROLE: (\w+)/);
  return m ? m[1] : 'builder';
}

const find = (msgs, pred) => msgs.find(pred) || {};

// ── BUILDER ────────────────────────────────────────────────────────────────
// claims a task, runs a check, submits, then tells the auditor
function builder(messages) {
  const done = callsSoFar(messages);
  const res = results(messages);
  const board = find(res, (r) => r.counts && r.tasks);
  const claimable = (board.tasks || []).find((t) => t.status === 'backlog');
  const mine = (board.tasks || []).find((t) => t.status === 'in_progress');

  if (!done.includes('read_brief') && !done.includes('list_tasks')) {
    return { name: 'list_tasks', args: {} };
  }
  if (claimable && !done.includes('claim_task')) {
    return { name: 'claim_task', args: { taskId: claimable.id } };
  }
  const claimed = res.find((r) => r.id && r.status === 'in_progress');
  const taskId = claimed?.id || mine?.id || claimable?.id;

  if (!done.includes('run_command')) {
    return { name: 'run_command', args: { command: 'echo "ingest: posting the same row twice leaves one row"; echo ok' } };
  }
  if (taskId && !done.includes('submit_task')) {
    const ran = res.find((r) => r.sha256 && r.output);
    return {
      name: 'submit_task',
      args: {
        taskId,
        summary: 'wired the dedupe key into ingest; posting the same row twice leaves one row',
        artifacts: [{ commit: (ran?.sha256 || 'sha256:0').slice(7, 14), path: 'src/ingest.ts', contentHash: 'sha256:' + (ran?.sha256 || '').slice(0, 8) }],
      },
    };
  }
  if (!done.includes('post')) {
    return { name: 'post', args: { text: 'ingest is submitted — the dedupe key is in, would you falsify it?', to: 'auditor-1' } };
  }
  return { name: 'finish', args: { finished: 'claimed and submitted the ingest task', unfinished: 'no witness yet', next: 'auditor-1 runs the malformed-input case' } };
}

// ── AUDITOR ────────────────────────────────────────────────────────────────
// answers the builder, tries to break the work, passes only with a control
function auditor(messages) {
  const done = callsSoFar(messages);
  const res = results(messages);
  const board = find(res, (r) => r.counts && r.tasks);
  const review = (board.tasks || []).find((t) => t.status === 'review');
  const inbox = find(res, (r) => r.messages);

  if (!done.includes('read_brief') && !done.includes('list_tasks')) {
    return { name: 'list_tasks', args: {} };
  }
  if ((inbox.messages || []).length && !done.includes('post')) {
    const line = inbox.messages[0];
    return { name: 'post', args: { text: 'on it. send me the exact command and I will run it against the control too.', to: line.actor, replyTo: String(line.seq) } };
  }
  if (review && !done.includes('run_command')) {
    return { name: 'run_command', args: { command: 'echo "falsify: POST /ingest twice -> 1 row"; echo "control: POST /ingest twice with dedupe=off -> 2 rows (expected failure)"' } };
  }
  if (review && !done.includes('witness_task')) {
    const ran = res.find((r) => r.sha256 && r.output);
    const digest = 'sha256:' + (ran?.sha256 || 'deadbeef').slice(0, 16);
    return {
      name: 'witness_task',
      args: {
        taskId: review.id,
        verdict: 'pass',
        reason: 'posted the same row twice and got one row; the same probe with dedupe off returns two, so the check can fail',
        falsification: { command: 'POST /ingest twice', output_digest: digest },
        instrumentControl: { command: 'POST /ingest twice with dedupe=off', output_digest: digest, expected_failure: 'two rows appear' },
      },
    };
  }
  return { name: 'finish', args: { finished: 'witnessed the ingest task with a falsification and a control', unfinished: 'nothing on the board', next: 'wait for the next submission' } };
}

// ── LEAD ───────────────────────────────────────────────────────────────────
// directs; cannot witness; keeps the record honest
function lead(messages) {
  const done = callsSoFar(messages);
  if (!done.includes('read_brief')) return { name: 'read_brief', args: {} };
  if (!done.includes('post')) {
    return { name: 'post', args: { text: 'the ingest task is the one that matters — builder, prove the duplicate case; auditor, falsify it against the same control.', to: 'all' } };
  }
  return { name: 'finish', args: { finished: 'pointed the crew at the ingest task', unfinished: 'witness still outstanding', next: 'check the ledger once the witness lands' } };
}

const POLICIES = { builder, auditor, lead };

createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* empty */
    }
    const messages = payload.messages || [];
    const role = process.env.JATIN_STUB_ROLE || roleOf(messages);
    const pick = (POLICIES[role] || builder)(messages);

    const toolCall = {
      id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      type: 'function',
      function: { name: pick.name, arguments: JSON.stringify(pick.args || {}) },
    };

    // a "finish" is a plain answer, not a tool call — same as a real model
    const message =
      pick.name === 'finish'
        ? { role: 'assistant', content: `done. ${JSON.stringify(pick.args)}` }
        : { role: 'assistant', content: null, tool_calls: [toolCall] };

    const out = {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      model: payload.model || 'stub',
      choices: [{ index: 0, message, finish_reason: pick.name === 'finish' ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
}).listen(PORT, '0.0.0.0', () => console.log(`[stub-model] ${PORT} — a policy, not a mind`));
