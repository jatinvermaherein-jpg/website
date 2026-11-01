import Fastify from 'fastify';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';
import { flowRoutes } from './routes/flow.js';
import { serviceRoutes } from './routes/services.js';
import { streamRoutes } from './routes/stream.js';
import { seatRoutes } from './routes/seats.js';
import { crewRoutes } from './routes/crew.js';
import { crosscheckRoutes } from './routes/crosscheck.js';
import { benchRoutes } from './routes/bench.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { staticRoutes } from './static.js';
import { prisma } from './lib/prisma.js';

export async function buildApp() {
  const app = Fastify({ logger: false });

  // CORS for exactly one foreign origin: the deployed site (WEB_ORIGIN),
  // for when the dashboard talks to the API directly (same-origin through
  // a proxy needs none of this; direct calls do). No Origin header —
  // tests, curl, other origins — gets no CORS headers at all.
  const webOrigin = process.env.WEB_ORIGIN;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' && webOrigin && req.headers.origin === webOrigin) {
      reply
        .header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
        .header('access-control-allow-headers', 'content-type,authorization')
        .header('access-control-max-age', '86400')
        .code(204)
        .send();
    }
  });
  app.addHook('onSend', async (req, reply) => {
    // the header is needed on error responses too (the browser may only
    // read the error body because of it) — and it only ever matches the
    // one origin we trust, so it is inert everywhere else.
    if (webOrigin && req.headers.origin === webOrigin) {
      reply.header('access-control-allow-origin', req.headers.origin).header('vary', 'origin');
    }
  });

  // The dashboard always sends `content-type: application/json`, and some of
  // its actions (revoke, kill) send NO body. Fastify's default JSON parser
  // hard-fails those with FST_ERR_CTP_EMPTY_JSON_BODY before the route
  // answers — treat an empty body as an empty object instead.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const s = (body ?? '').toString().trim();
      if (!s) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (e) {
        done(e as Error);
      }
    },
  );

  await app.register(cookie);

  app.get('/health', healthRoutes);

  // public pulse — the landing page's live badge. AGGREGATE telemetry only:
  // system uptime and totals, never tenant data, never a secret.
  app.get('/api/pulse', async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [requests24h, crewsRunning] = await Promise.all([
      prisma.request.count({ where: { createdAt: { gte: since } } }),
      prisma.task.count({ where: { status: 'in_progress' } }),
    ]);
    return { up: true, version: '1.0.0', uptimeS: Math.round(process.uptime()), requests24h, crewsRunning };
  });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(accountRoutes, { prefix: '/api/account' });
  await app.register(flowRoutes, { prefix: '/api/flow' });
  await app.register(serviceRoutes, { prefix: '/api/flow' }); // search + image — one key, all three faces
  await app.register(streamRoutes, { prefix: '/api/projects' });
  await app.register(seatRoutes, { prefix: '/api/projects' }); // the real agents
  await app.register(crewRoutes, { prefix: '/api/crew' });
  await app.register(crosscheckRoutes, { prefix: '/api/projects' });
  await app.register(benchRoutes, { prefix: '/api/projects' });
  await app.register(portfolioRoutes, { prefix: '/api/portfolio' });
  app.register(staticRoutes);

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error('[jatin]', err);
    reply.status(status).send({ error: err.message || 'internal error' });
  });

  return app;
}
