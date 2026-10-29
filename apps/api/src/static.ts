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

export async function staticRoutes(app: FastifyInstance) {
  app.get('/', (req, reply) => sendFile(reply, 'index.html'));
  app.get('/index.html', (req, reply) => sendFile(reply, 'index.html'));
  app.get('/login.html', (req, reply) => sendFile(reply, 'login.html'));
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
