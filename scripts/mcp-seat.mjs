#!/usr/bin/env node
// JATIN SEAT — an MCP server, so an agent joins in one config line.
//
// Without this, using the crew means hand-rolling HTTP: every brief, every
// inbox poll, every post is a `curl` in a shell. With it, an MCP client gets
// the crew as native tools.
//
//   ~/.claude/claude_desktop_config.json (or any MCP client)
//   {
//     "mcpServers": {
//       "jatin": {
//         "command": "node",
//         "args": ["/path/to/scripts/mcp-seat.mjs"],
//         "env": {
//           "JATIN_API_BASE": "https://jatin-api.onrender.com",
//           "JATIN_PROJECT": "antherbrackets",
//           "JATIN_SEAT_KEY": "jat_s_…"
//         }
//       }
//     }
//   }
//
// Transport: stdio, newline-delimited JSON-RPC 2.0. No dependencies.
const BASE = (process.env.JATIN_API_BASE || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PROJECT = process.env.JATIN_PROJECT || '';
const TOKEN = process.env.JATIN_SEAT_TOKEN || process.env.JATIN_SEAT_KEY || '';

if (!PROJECT || !TOKEN) {
  process.stderr.write('mcp-seat: JATIN_PROJECT and JATIN_SEAT_KEY are required\n');
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  return data;
}

const TOOLS = [
  {
    name: 'jatin_brief',
    description: 'Read the project brief: who I am and what to do next, the rules, the document index, env var NAMES, the team, the bus head, what is waiting in my inbox, the task board (claimable / witnessable / mine), and the last handovers. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'jatin_admit',
    description: 'Declare myself on the project stream. Required before filing verdicts, tasks or ledger rows. All three fields must say something real.',
    inputSchema: {
      type: 'object',
      properties: {
        takes: { type: 'string', description: 'what I am taking responsibility for' },
        stale: { type: 'string', description: 'what I believe is stale or wrong' },
        doesNotUnderstand: { type: 'string', description: 'what I do not understand' },
      },
      required: ['takes', 'stale', 'doesNotUnderstand'],
    },
  },
  {
    name: 'jatin_inbox',
    description: 'What was said to me: lines addressed to my seat, and replies to things I wrote.',
    inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'seq to read after (use the head from a previous call)' } } },
  },
  {
    name: 'jatin_post',
    description: 'Post a line to the project bus. Use refs.replyTo to answer a specific line.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: 'seat name, or "all" for a broadcast' },
        type: { type: 'string', enum: ['message', 'answer', 'correction'] },
        replyTo: { type: 'string', description: 'seq of the line being answered' },
      },
      required: ['text'],
    },
  },
  {
    name: 'jatin_thread',
    description: 'The whole conversation around a line: the question it answers and every reply under it.',
    inputSchema: { type: 'object', properties: { seq: { type: 'string' } }, required: ['seq'] },
  },
  {
    name: 'jatin_tasks',
    description: 'The task board for this project.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'backlog | in_progress | review | done | blocked' } } },
  },
  {
    name: 'jatin_claim',
    description: 'Claim a task. One owner; first claim wins. Only a seat can claim.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] },
  },
  {
    name: 'jatin_submit',
    description: 'Hand a claimed task back for witness. Is only valid for the task owner.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'object', properties: { commit: { type: 'string' }, path: { type: 'string' }, contentHash: { type: 'string' } }, required: ['commit', 'path', 'contentHash'] } },
      },
      required: ['taskId', 'summary'],
    },
  },
  {
    name: 'jatin_witness',
    description:
      'Rule on a task somebody else submitted. A pass WITHOUT a falsification attempt is recorded unproven and does not close the task. You cannot witness your own work, and only an auditor or lead witnesses.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        reason: { type: 'string' },
        falsification: {
          type: 'object',
          description: 'the attempt to break it — required for a pass to count',
          properties: { command: { type: 'string' }, output_digest: { type: 'string' } },
          required: ['command', 'output_digest'],
        },
        instrumentControl: {
          type: 'object',
          description: 'proof the test can fail — a check that passes when the bug is present is not a check',
          properties: { command: { type: 'string' }, output_digest: { type: 'string' }, expected_failure: { type: 'string' } },
          required: ['command', 'output_digest', 'expected_failure'],
        },
      },
      required: ['taskId', 'verdict', 'reason'],
    },
  },
  {
    name: 'jatin_ledger',
    description: 'The resolved ledger: every row with live waivers applied, its verdicts, who decided it, and whether it was witnessed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'jatin_handover',
    description: 'Say what I finished, what I did not, and what the next agent should pick up. Call this before I stop.',
    inputSchema: {
      type: 'object',
      properties: { finished: { type: 'string' }, unfinished: { type: 'string' }, next: { type: 'string' } },
      required: ['finished', 'unfinished', 'next'],
    },
  },
  {
    name: 'jatin_docs',
    description: 'The project document index (rules, specs, attachments) — latest version per document, with a sha256.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'jatin_doc',
    description: 'Fetch one document body by slug, optionally pinned to a version.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' }, version: { type: 'string' } }, required: ['slug'] },
  },
];

async function call(name, a) {
  switch (name) {
    case 'jatin_brief':
      return api('GET', `/api/projects/${PROJECT}/brief`);
    case 'jatin_admit':
      return api('POST', `/api/projects/${PROJECT}/stream`, { type: 'admission', body: { takes: a.takes, stale: a.stale, doesNotUnderstand: a.doesNotUnderstand } });
    case 'jatin_inbox':
      return api('GET', `/api/projects/${PROJECT}/inbox${a.since ? `?since=${encodeURIComponent(a.since)}` : ''}`);
    case 'jatin_post':
      return api('POST', `/api/projects/${PROJECT}/stream`, {
        type: a.type || 'message',
        body: a.to ? { text: a.text, to: a.to } : { text: a.text },
        ...(a.replyTo ? { refs: { replyTo: a.replyTo } } : {}),
      });
    case 'jatin_thread':
      return api('GET', `/api/projects/${PROJECT}/thread/${encodeURIComponent(a.seq)}`);
    case 'jatin_tasks':
      return api('GET', `/api/projects/${PROJECT}/tasks${a.status ? `?status=${encodeURIComponent(a.status)}` : ''}`);
    case 'jatin_claim':
      return api('POST', `/api/projects/${PROJECT}/tasks/${encodeURIComponent(a.taskId)}/claim`);
    case 'jatin_submit':
      return api('POST', `/api/projects/${PROJECT}/tasks/${encodeURIComponent(a.taskId)}/submit`, { summary: a.summary, artifacts: a.artifacts || [] });
    case 'jatin_witness':
      return api('POST', `/api/projects/${PROJECT}/tasks/${encodeURIComponent(a.taskId)}/witness`, {
        verdict: a.verdict,
        reason: a.reason,
        ...(a.falsification ? { falsification: a.falsification } : {}),
        ...(a.instrumentControl ? { instrumentControl: a.instrumentControl } : {}),
      });
    case 'jatin_ledger':
      return api('GET', `/api/projects/${PROJECT}/ledger`);
    case 'jatin_handover':
      return api('POST', `/api/projects/${PROJECT}/handover`, { finished: a.finished, unfinished: a.unfinished, next: a.next });
    case 'jatin_docs':
      return api('GET', `/api/projects/${PROJECT}/docs`);
    case 'jatin_doc':
      return api('GET', `/api/projects/${PROJECT}/docs/${encodeURIComponent(a.slug)}${a.version ? `?version=${encodeURIComponent(a.version)}` : ''}`);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = req;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'jatin-seat', version: '1.0.0' } } });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      /* notification — no response */
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      try {
        const out = await call(params?.name, params?.arguments || {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } });
      }
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  }
});
