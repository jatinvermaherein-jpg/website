// Static site (apps/web) served by the API for local dev. In production
// Netlify serves the site and /api/* rewrites to this service.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFileSync, existsSync } from 'node:fs';

const WEB = new URL('../../web/', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.json': 'application/json',
};

function sendFile(reply: FastifyReply, rel: string): void {
  const path = WEB + rel.replace(/^\/+/, '');
  if (!existsSync(path)) {
    reply.code(404).header('content-type', 'text/plain').send('404');
    return;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  const type = MIME[ext] ?? 'application/octet-stream';
  const body = ext === '.html' || ext === '.css' || ext === '.js' || ext === '.svg' || ext === '.json'
    ? readFileSync(path, 'utf8')
    : readFileSync(path);
  reply.header('content-type', type).header('cache-control', 'no-cache').send(body);
}

// the API host is a real entry point (people click it) — when the web build
// is not in this image, serve a small honest card instead of a 404
const FALLBACK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jatin API</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0B0E1A;color:#E8EAF2;font:16px/1.5 system-ui,sans-serif}
main{max-width:520px;padding:40px;text-align:center}
h1{font-size:28px;margin:0 0 8px;letter-spacing:.04em}
p{color:#9aa1b5;margin:12px 0}
code{background:#151a2c;padding:2px 8px;border-radius:6px;font-size:14px;color:#cdd3e4}
</style></head>
<body><main>
<h1>Jatin API</h1>
<p>The full site lives at its own address; this host runs the API.</p>
<p><code>/health</code> — status &middot; <code>/api/flow/chat/completions</code> — OpenAI-compatible gateway</p>
</main></body></html>`;

export async function staticRoutes(app: FastifyInstance) {
  app.get('/', (req, reply) => {
    if (!existsSync(WEB + 'index.html')) {
      reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-cache').send(FALLBACK);
      return;
    }
    sendFile(reply, 'index.html');
  });
  app.get('/index.html', (req, reply) => sendFile(reply, 'index.html'));
  app.get('/login.html', (req, reply) => sendFile(reply, 'login.html'));
  app.get('/flow.html', (req, reply) => sendFile(reply, 'flow.html'));
  app.get('/crew.html', (req, reply) => sendFile(reply, 'crew.html'));
  app.get('/dashboard', (req, reply) => sendFile(reply, 'dashboard.html'));
  app.get('/dashboard.html', (req, reply) => sendFile(reply, 'dashboard.html'));
  app.get('/preloader.css', (req, reply) => sendFile(reply, 'preloader.css'));
  app.get('/preloader.js', (req, reply) => sendFile(reply, 'preloader.js'));
  app.get('/site.css', (req, reply) => sendFile(reply, 'site.css'));
  app.get('/favicon.svg', (req, reply) => sendFile(reply, 'favicon.svg'));
  app.get('/fonts/:family/:file', (req, reply) => {
    const { family, file } = req.params as { family: string; file: string };
    if (!/^[a-z0-9-]+$/.test(family) || !/^[a-z0-9.-]+$/.test(file)) {
      reply.code(400).send('bad path');
      return;
    }
    sendFile(reply, `fonts/${family}/${file}`);
  });
}
