// JATIN_UPSTREAM_BASE dev upstream — a local OpenAI-compatible echo.
//
// The sandbox has no real provider keys. To exercise the REAL gateway
// end-to-end (pool → upstream → measured usage → ledger) without burning
// provider quota, run this and point the API at it:
//
//   node scripts/dev-upstream.mjs                 # prints its URL
//   JATIN_UPSTREAM_BASE=http://127.0.0.1:8091/v1 npm run dev
//
// Same seam the test suite uses (JATIN_UPSTREAM_BASE) — the gateway code
// under the wire is the real one. Remove the env var for production:
// the gateway then calls the actual providers.
import http from 'node:http';

const PORT = process.env.DEV_UPSTREAM_PORT ? Number(process.env.DEV_UPSTREAM_PORT) : 8091;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j;
    try {
      j = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    const prompt = String((j.messages ?? []).map((m) => String(m.content)).join(' '));
    const tokensIn = Math.max(1, Math.ceil(prompt.length / 4));
    const completion = 'This reply came from the local dev echo upstream.';
    const tokensOut = 9;
    const usage = { prompt_tokens: tokensIn, completion_tokens: tokensOut, total_tokens: tokensIn + tokensOut };

    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const words = completion.split(' ');
      words.forEach((w, i) => {
        res.write(`data: ${JSON.stringify({ id: 'echo-1', choices: [{ delta: { content: i ? ` ${w}` : w } }] })}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ id: 'echo-1', choices: [], usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'echo-1', choices: [{ message: { role: 'assistant', content: completion } }], usage }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dev-upstream] OpenAI-compatible echo on http://127.0.0.1:${PORT}/v1`);
  console.log(`[dev-upstream] start the API with: JATIN_UPSTREAM_BASE=http://127.0.0.1:${PORT}/v1 npm run dev`);
});
