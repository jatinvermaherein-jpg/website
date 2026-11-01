// Seat credential plumbing — how a REAL agent authenticates on the project
// stream. Two credentials, one identity:
//
//   SeatKey   — the seat's standing credential. Shown exactly once at
//               creation; only the SHA-256 hash is stored. The agent keeps
//               it (env, secret store) and presents it on every stream call.
//               Works from anywhere — that is the external team member.
//   Session   — a run-scoped token handed to a seat process the crew SPAWNS
//               on the host. Never leaves the host (env of the child only),
//               expires with the run. Same stream rights, no standing secret
//               needed on the server.
import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { prisma } from './prisma.js';
import type { Seat } from '@prisma/client';

export const SEAT_KEY_PREFIX = 'jat_s_';
export const SEAT_SESSION_PREFIX = 'jat_t_';
export const seatSha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function seatFromBearer(req: FastifyRequest): Promise<Seat | null> {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  let seatId: string | null = null;
  if (token.startsWith(SEAT_KEY_PREFIX)) {
    const key = await prisma.seatKey.findUnique({ where: { keyHash: seatSha256(token) } });
    if (key && !key.revokedAt) seatId = key.seatId;
  } else if (token.startsWith(SEAT_SESSION_PREFIX)) {
    const s = await prisma.session.findUnique({ where: { tokenHash: seatSha256(token) } });
    if (s && (!s.expiresAt || s.expiresAt.getTime() > Date.now())) seatId = s.seatId;
  }
  if (!seatId) return null;
  const seat = await prisma.seat.findUnique({ where: { id: seatId } });
  if (!seat || seat.status === 'archived') return null;
  return seat;
}

// Presence law: any read or post on the stream is a heartbeat. The board's
// "online" is lastHeartbeat within 90s. Fail open, fire and forget.
export function touchSeat(seatId: string): void {
  prisma.seat
    .update({ where: { id: seatId }, data: { lastHeartbeat: new Date(), status: 'online' } })
    .catch(() => {});
}

export const SEAT_ONLINE_MS = 90_000;
