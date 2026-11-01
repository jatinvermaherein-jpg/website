// Crew worker — one seat on the crew.
//
// role=builder: appends units of work to its partial artifact.
// role=auditor: reviews the builders' partials as they land — every tick it
// recounts what the other seats have written and logs the review line. The
// audit IS its partial: a killed auditor leaves its review trail visible.
//
// SIGTERM = clean stop (the partial stays on disk — a killed crew leaves its
// work visible, not vaporized).
import { appendFileSync, readFileSync } from 'node:fs';

const [outDir, i, durationMs, role, total] = process.argv.slice(2);
const n = Number(total) || 1;
const me = Number(i);
const path = `${outDir}/partial-${i}.log`;
let t = 0;

function builderLines() {
  let lines = 0;
  let parts = 0;
  for (let j = 1; j <= n; j++) {
    if (j === me) continue; // never count yourself
    try {
      const c = readFileSync(`${outDir}/partial-${j}.log`, 'utf8');
      lines += c.split('\n').filter(Boolean).length;
      parts++;
    } catch {
      /* that seat hasn't written yet */
    }
  }
  return { lines, parts };
}

const timer = setInterval(() => {
  t += 200;
  if (role === 'auditor') {
    const { lines, parts } = builderLines();
    appendFileSync(path, `audit t=${t}ms · reviewed ${lines} builder lines across ${parts} partial(s) · ok\n`);
  } else {
    appendFileSync(path, `worker ${i} t=${t}ms · unit of work (hash ${Math.random().toString(16).slice(2, 10)})\n`);
  }
  if (t >= Number(durationMs)) {
    clearInterval(timer);
    if (role === 'auditor') {
      const { lines } = builderLines();
      appendFileSync(path, `audit COMPLETE at ${t}ms · ${lines} builder lines reviewed\n`);
    } else {
      appendFileSync(path, `worker ${i} COMPLETE at ${t}ms\n`);
    }
    process.exit(0);
  }
}, 200);

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(143); // the partial file remains — the board keeps it
});
