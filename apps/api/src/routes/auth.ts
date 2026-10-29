// O3 — username + password auth, self-created on the website, pending until
// the operator verifies. The operator's own credentials come from backend env.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../lib/hash.js';
import { signJwt } from '../lib/jwt.js';
import { requireUser } from '../lib/auth.js';

const credentials = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, 'username: 3-32 chars, a-z 0-9 _ . -'),
  password: z.string().min(8, 'password: at least 8 characters').max(200),
});

const SESSION_MINUTES = 15;

export async function authRoutes(app: FastifyInstance) {
  app.post('/register', async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid credentials' });
    }
    const { username, password } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return reply.code(409).send({ error: 'username taken' });

    const user = await prisma.user.create({
      data: { username, passHash: await hashPassword(password), status: 'pending' },
    });
    const org = await prisma.org.create({ data: { name: username } });
    await prisma.membership.create({ data: { userId: user.id, orgId: org.id, role: 'owner' } });

    return reply.code(201).send({
      username,
      status: 'pending',
      note: 'Your account is pending verification by the operator. You can sign in once it is verified.',
    });
  });

  app.post('/login', async (req, reply) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid credentials' });
    const { username, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !(await verifyPassword(password, user.passHash))) {
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    if (user.status === 'pending') {
      return reply.code(403).send({ error: 'account pending verification — the operator must verify you from the dashboard' });
    }
    if (user.status === 'suspended') {
      return reply.code(403).send({ error: 'account suspended' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) return reply.code(500).send({ error: 'server misconfigured' });
    const token = signJwt({ sub: user.id, username: user.username, operator: user.isOperator }, secret, SESSION_MINUTES * 60);
    reply.setCookie('jatin_session', token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MINUTES * 60,
    });
    return { token, username: user.username, operator: user.isOperator };
  });

  app.get('/me', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    return { username: user.username, status: user.status, operator: user.isOperator };
  });

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie('jatin_session', { path: '/' });
    return { ok: true };
  });
}
