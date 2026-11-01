// JATIN API — bootstrap. Loads .env, ensures the operator account exists
// (O3: the operator's credentials come from backend env), listens on 0.0.0.0.
import { loadDotEnv } from './lib/env.js'; // first — DATABASE_URL before PrismaClient
import { buildApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { hashPassword } from './lib/hash.js';
import { refreshStalePoolCatalogs } from './lib/catalog.js';
import { refreshModelLiveness } from './lib/liveness.js';
import { operatorOrgId } from './routes/flow.js';

async function ensureOperator(): Promise<void> {
  const u = process.env.ADMIN_USERNAME;
  const pw = process.env.ADMIN_PASSWORD;
  if (!u || !pw) {
    console.warn('[jatin] ADMIN_USERNAME/ADMIN_PASSWORD not set — operator bootstrap skipped (seed it)');
    return;
  }
  const existing = await prisma.user.findUnique({ where: { username: u } });
  if (!existing) {
    const user = await prisma.user.create({
      data: { username: u, passHash: await hashPassword(pw), status: 'active', isOperator: true },
    });
    // Mirror the registration flow (auth.ts): the operator immediately owns
    // their own org, so the dashboard works from first sign-in.
    const org = await prisma.org.create({ data: { name: u } });
    await prisma.membership.create({ data: { userId: user.id, orgId: org.id, role: 'owner' } });
    console.log(`[jatin] bootstrapped operator account from env: ${u} (org ${org.id}, owner)`);
    return;
  }
  // Self-heal: an operator bootstrapped before org provisioning (or any
  // account without a membership) gets its org on boot — idempotent.
  const hasOrg = await prisma.membership.findFirst({ where: { userId: existing.id } });
  if (!hasOrg) {
    const org = await prisma.org.create({ data: { name: u } });
    await prisma.membership.create({ data: { userId: existing.id, orgId: org.id, role: 'owner' } });
    console.log(`[jatin] provisioned missing org for operator ${u} (org ${org.id}, owner)`);
  }
}

loadDotEnv();

// Say it at boot, not at the first request that needs it. A missing master
// key means every secret-touching route will answer 503; better to know now.
if (!process.env.MASTER_KEY) {
  console.warn('[jatin] MASTER_KEY is not set — provider keys and project env cannot be encrypted (secret routes will answer 503)');
}

const app = await buildApp();

try {
  await ensureOperator();
} catch (e) {
  console.error('[jatin] operator bootstrap failed — is the database up?', e);
}

const port = Number(process.env.PORT || 8080);
await app.listen({ host: '0.0.0.0', port });
console.log(`[jatin] api on http://0.0.0.0:${port} — landing + preloader at /`);

// 0006 — daily model-catalog checks. Provider model lists change (often
// daily), so on boot — and hourly — refresh every pool key whose catalog
// was checked more than 20h ago. Strictly background: a failing or slow
// provider must never delay boot or serve traffic.
const catalogTick = async (): Promise<void> => {
  try {
    const op = await operatorOrgId();
    if (op) {
      await refreshStalePoolCatalogs(prisma, [op]);
      // 0008 — keep per-key MODEL liveness fresh too: which keys can actually
      // serve each rung model. Bounded (a few probes/tick), strictly background.
      void refreshModelLiveness(prisma, [op], 6).catch(() => {});
    }
  } catch (e) {
    console.error('[jatin] catalog tick failed', e);
  }
};
void catalogTick();
const catalogTimer = setInterval(() => void catalogTick(), 3600_000);
catalogTimer.unref?.();
