import Fastify from 'fastify';
import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';
import { flowRoutes } from './routes/flow.js';
import { streamRoutes } from './routes/stream.js';
import { crewRoutes } from './routes/crew.js';
import { crosscheckRoutes } from './routes/crosscheck.js';
import { benchRoutes } from './routes/bench.js';
import { staticRoutes } from './static.js';

export async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  app.get('/health', healthRoutes);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(accountRoutes, { prefix: '/api/account' });
  await app.register(flowRoutes, { prefix: '/api/flow' });
  await app.register(streamRoutes, { prefix: '/api/projects' });
  await app.register(crewRoutes, { prefix: '/api/crew' });
  await app.register(crosscheckRoutes, { prefix: '/api/projects' });
  await app.register(benchRoutes, { prefix: '/api/projects' });
  app.register(staticRoutes);

  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error('[jatin]', err);
    reply.status(status).send({ error: err.message || 'internal error' });
  });

  return app;
}
