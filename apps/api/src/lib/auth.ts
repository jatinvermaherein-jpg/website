// Session plumbing: cookie or bearer → JWT → live user row.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyJwt } from './jwt.js';
import { prisma } from './prisma.js';
import type { User } from '@prisma/client';

export interface AuthedUser extends User {}

function bearerFrom(req: FastifyRequest): string | null {
  const cookie = (req.cookies as Record<string, string> | undefined)?.jatin_session;
  if (cookie) return cookie;
  const h = req.headers.authorization;
  if (h && /^Bearer /i.test(h)) return h.replace(/^Bearer /i, '');
  return null;
}

export async function currentUser(req: FastifyRequest): Promise<AuthedUser | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const token = bearerFrom(req);
  if (!token) return null;
  const payload = verifyJwt(token, secret);
  if (!payload || typeof payload.sub !== 'string') return null;
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.status !== 'active') return null;
  return user;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
  const user = await currentUser(req);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
  const user = await requireUser(req, reply);
  if (user && !user.isOperator) {
    await reply.code(403).send({ error: 'operator only' });
    return null;
  }
  return user;
}
