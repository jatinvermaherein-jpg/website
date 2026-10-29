import { prisma } from '../lib/prisma.js';

export async function healthRoutes() {
  let db: 'up' | 'down' = 'down';
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = 'up';
  } catch {
    // health reports honestly; it does not throw
  }
  return {
    status: db === 'up' ? 'ok' : 'degraded',
    db,
    uptimeSec: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  };
}
