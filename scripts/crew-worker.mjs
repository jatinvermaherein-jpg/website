// Crew worker — does one slice of the task: appends units of work to its
// partial artifact. SIGTERM = clean stop (the partial stays on disk — that's
// the point: a killed crew leaves its partial work visible, not vaporized).
import { appendFileSync } from 'node:fs';

const [outDir, i, durationMs] = process.argv.slice(2);
const path = `${outDir}/partial-${i}.log`;
let t = 0;

const timer = setInterval(() => {
  t += 200;
  appendFileSync(path, `worker ${i} t=${t}ms · unit of work (hash ${Math.random().toString(16).slice(2, 10)})\n`);
  if (t >= Number(durationMs)) {
    clearInterval(timer);
    appendFileSync(path, `worker ${i} COMPLETE at ${t}ms\n`);
    process.exit(0);
  }
}, 200);

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(143); // the partial file remains — the board keeps it
});
