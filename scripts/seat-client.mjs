#!/usr/bin/env node
// JATIN seat client — the team bus for a real agent (Node 18+, no deps).
//
// Env: JATIN_API_BASE, JATIN_PROJECT, JATIN_SEAT, JATIN_SEAT_ROLE,
//      JATIN_SEAT_TOKEN (spawned) or JATIN_SEAT_KEY (standing).
//
// CLI:
//   node seat-client.mjs hello                          # post one line, exit
//   node seat-client.mjs follow [--interval 2]          # tail the bus (heartbeat)
//   node seat-client.mjs post "text" [--to NAME] [--type T]
//   node seat-client.mjs run "python3 my_agent.py"      # spawn YOUR agent with the env, then watch
//
// Library:
//   import { readStream, postLine } from './seat-client.mjs';
const BASE = process.env.JATIN_API_BASE || "http://127.0.0.1:8080";
const PROJECT = process.env.JATIN_PROJECT || "";
const TOKEN = process.env.JATIN_SEAT_TOKEN || process.env.JATIN_SEAT_KEY || "";
const SEAT = process.env.JATIN_SEAT || "?";
const ROLE = process.env.JATIN_SEAT_ROLE || "?";

async function req(method, path, payload) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  let d = {};
  try { d = await res.json(); } catch { /* empty */ }
  return { status: res.status, d };
}

export async function readStream(after = "0") {
  const { status, d } = await req("GET", `/api/projects/${PROJECT}/stream?afterSeq=${after}`);
  if (status !== 200) throw new Error(`read failed (${status}): ${JSON.stringify(d)}`);
  return d;
}

export async function postLine(text, { type = "message", to = undefined, ...extra } = {}) {
  const body = { text, ...extra };
  if (to) body.to = to;
  const { status, d } = await req("POST", `/api/projects/${PROJECT}/stream`, { type, body });
  if (status !== 201) throw new Error(`post refused (${status}): ${JSON.stringify(d)}`);
  return d;
}

function printLine(e) {
  const b = e.body || {};
  const txt = typeof b === "object" ? (b.text ?? JSON.stringify(b).slice(0, 160)) : String(b);
  const to = b && b.to ? ` → ${b.to}` : "";
  const flag = b && b.rejection ? " ⚠refused" : "";
  console.log(`[${e.actor}${to}] ${txt}${flag}`, { end: false }, "\n");
}

async function follow(interval = 2000) {
  let cursor = "0";
  console.log(`# seat ${SEAT} (${ROLE}) on project ${PROJECT} — following the bus`);
  for (;;) {
    const d = await readStream(cursor);
    for (const e of d.events || []) {
      printLine(e);
      const b = e.body || {};
      if (b && b.status === "killed" && b.attempt === "recorded") {
        console.log("# run killed — stopping.");
        return;
      }
    }
    cursor = d.nextCursor || cursor;
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "hello") {
    const d = await postLine(`seat ${SEAT} (${ROLE}) on the bus — hello`);
    console.log(`posted seq ${d.seq}`);
  } else if (cmd === "follow") {
    const i = rest.indexOf("--interval");
    const interval = i >= 0 ? Number(rest[i + 1]) * 1000 : 2000;
    await follow(interval);
  } else if (cmd === "post") {
    const to = rest.includes("--to") ? rest[rest.indexOf("--to") + 1] : undefined;
    const type = rest.includes("--type") ? rest[rest.indexOf("--type") + 1] : "message";
    const d = await postLine(rest[0] || "line", { to, type });
    console.log(`posted seq ${d.seq}`);
  } else if (cmd === "run") {
    const { spawn } = await import("node:child_process");
    const child = spawn(rest.join(" "), { shell: true, env: process.env, stdio: "inherit" });
    console.log(`# spawned ${child.pid} — following the bus`);
    await follow();
    child.kill();
  } else {
    console.error("usage: seat-client.mjs hello | follow | post \"text\" [--to N] [--type T] | run \"cmd\"");
    process.exit(2);
  }
}
