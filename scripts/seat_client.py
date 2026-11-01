#!/usr/bin/env python3
"""JATIN seat client — the team bus for a real agent. Stdlib only.

Env (all required except JATIN_API_BASE):
  JATIN_API_BASE   API origin            (default http://127.0.0.1:8080)
  JATIN_PROJECT    project slug (your bus)
  JATIN_SEAT       your seat name        (display only)
  JATIN_SEAT_ROLE  your role             (display only)
  JATIN_SEAT_TOKEN or JATIN_SEAT_KEY     the credential (Bearer)

Commands:
  hello                                  post one line, exit (seat smoke test)
  follow [--interval 2]                  tail the bus; each read is a heartbeat
  post "text" [--to NAME] [--type T]     post a line
  run "<cmd> ..."                        spawn YOUR agent with this env, then follow the bus
"""
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request

BASE = os.environ.get("JATIN_API_BASE", "http://127.0.0.1:8080")
PROJECT = os.environ.get("JATIN_PROJECT", "")
SEAT = os.environ.get("JATIN_SEAT", "?")
ROLE = os.environ.get("JATIN_SEAT_ROLE", "?")
TOKEN = os.environ.get("JATIN_SEAT_TOKEN") or os.environ.get("JATIN_SEAT_KEY") or ""


def die(msg: str) -> None:
    print(f"seat-client: {msg}", file=sys.stderr)
    sys.exit(2)


def req(method: str, path: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
    except Exception as e:  # network — the bus call itself failed
        return 0, {"error": str(e)}


def read(after: str = "0"):
    status, d = req("GET", f"/api/projects/{PROJECT}/stream?afterSeq={after}")
    if status != 200:
        die(f"read failed ({status}): {d}")
    return d


def post(text: str, typ: str = "message", to=None, **extra):
    body = dict(text=text, **extra)
    if to:
        body["to"] = to
    status, d = req("POST", f"/api/projects/{PROJECT}/stream", {"type": typ, "body": body})
    if status != 201:
        die(f"post refused ({status}): {d}")
    return d


def line(e):
    b = e.get("body") or {}
    txt = b.get("text") if isinstance(b, dict) else str(b)
    to = f" → {b['to']}" if isinstance(b, dict) and b.get("to") else ""
    flag = " ⚠refused" if b.get("rejection") else ""
    print(f"[{e.get('actor')}{to}] {txt or json.dumps(b)[:160]}{flag}", flush=True)


def follow(interval: float = 2.0):
    if not PROJECT or not TOKEN:
        die("JATIN_PROJECT and JATIN_SEAT_KEY (or JATIN_SEAT_TOKEN) are required")
    cursor = "0"
    print(f"# seat {SEAT} ({ROLE}) on project {PROJECT} — following the bus", flush=True)
    while True:
        d = read(cursor)
        for e in d.get("events", []):
            line(e)
            b = e.get("body") or {}
            if isinstance(b, dict) and b.get("status") in ("killed",) and b.get("attempt") == "recorded":
                print("# run killed — stopping.", flush=True)
                return
        cursor = d.get("nextCursor") or cursor
        time.sleep(interval)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        die(__doc__)
    cmd, rest = args[0], args[1:]
    if cmd == "hello":
        d = post(f"seat {SEAT} ({ROLE}) on the bus — hello", to=None)
        print(f"posted seq {d.get('seq')}")
    elif cmd == "follow":
        interval = 2.0
        if "--interval" in rest:
            interval = float(rest[rest.index("--interval") + 1])
            rest = rest[: rest.index("--interval")] + rest[rest.index("--interval") + 2:]
        follow(interval)
    elif cmd == "post":
        text = rest[0] if rest else "line"
        to = rest[rest.index("--to") + 1] if "--to" in rest else None
        typ = rest[rest.index("--type") + 1] if "--type" in rest else "message"
        d = post(text, typ=typ, to=to)
        print(f"posted seq {d.get('seq')}")
    elif cmd == "run":
        if not rest:
            die("run needs a command: run \"python3 my_agent.py --flag\"")
        child = subprocess.Popen(shlex.join(rest), shell=True, env=os.environ.copy())
        print(f"# spawned {child.pid} with the seat env — following the bus", flush=True)
        follow()
        child.wait()
    else:
        die(__doc__)


if __name__ == "__main__":
    main()
