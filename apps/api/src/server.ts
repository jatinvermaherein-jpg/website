// JATIN API — bootstrap. Loads .env, ensures the operator account exists
// (O3: the operator's credentials come from backend env), listens on 0.0.0.0.
import { loadDotEnv } from './lib/env.js'; // first — DATABASE_URL before PrismaClient
import { buildApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { hashPassword } from './lib/hash.js';

async function ensureOperator(): Promise<void> {
  const u = process.env.ADMIN_USERNAME;
  const pw = process.env.ADMIN_PASSWORD;
  if (!u || !pw) {
    console.warn('[jatin] ADMIN_USERNAME/ADMIN_PASSWORD not set — operator bootstrap skipped (seed it)');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { username: u } });
  if (!existing) {
    await prisma.user.create({
      data: { username: u, passHash: await hashPassword(pw), status: 'active', isOperator: true },
    });
    console.log(`[jatin] bootstrapped operator account from env: ${u}`);
  }
}

loadDotEnv();

const app = await buildApp();

try {
  await ensureOperator();
} catch (e) {
  console.error('[jatin] operator bootstrap failed — is the database up?', e);
}

const port = Number(process.env.PORT || 8080);
await app.listen({ host: '0.0.0.0', port });
console.log(`[jatin] api on http://0.0.0.0:${port} — landing + preloader at /`);
