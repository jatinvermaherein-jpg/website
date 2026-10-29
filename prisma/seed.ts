// JATIN seed — O3: the operator account is seeded from backend env
// (ADMIN_USERNAME / ADMIN_PASSWORD). Idempotent: safe to re-run.
import { loadDotEnv } from '../apps/api/src/lib/env.js'; // first — .env before client
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../apps/api/src/lib/hash.js';

// Bootstrap is owner work: the seed explicitly uses DATABASE_URL (owner),
// never the restricted runtime role.
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

async function main() {
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPassword) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be set (backend env, per O3)');
  }

  // 1 · operator account (active from birth — it is the verifier)
  let operator = await prisma.user.findUnique({ where: { username: adminUser } });
  if (!operator) {
    operator = await prisma.user.create({
      data: { username: adminUser, passHash: await hashPassword(adminPassword), status: 'active', isOperator: true },
    });
    console.log(`seeded operator account: ${adminUser}`);
  }

  // 2 · the operator's org
  let org = await prisma.org.findFirst({ where: { name: 'jatin' } });
  if (!org) {
    org = await prisma.org.create({ data: { name: 'jatin', plan: 'operator' } });
    console.log(`seeded org: ${org.id}`);
  }
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: operator.id, orgId: org.id } },
    update: { role: 'owner' },
    create: { userId: operator.id, orgId: org.id, role: 'owner' },
  });

  // 3 · the first project — the build of Jatin itself (dogfooding)
  let project = await prisma.project.findUnique({ where: { slug: 'jatin' } });
  if (!project) {
    project = await prisma.project.create({
      data: { orgId: org.id, slug: 'jatin', name: 'Jatin — the build', status: 'active', maxSeats: 20 },
    });
    console.log(`seeded project: ${project.slug} (${project.id})`);
  }

  // 4 · law book v1 pinned for the project (versioned; body cites the
  //    canonical text in workspace/ — the full book is an artifact, not a blob)
  const existing = await prisma.ruleset.findUnique({ where: { projectId_version: { projectId: project.id, version: 1 } } });
  if (!existing) {
    await prisma.ruleset.create({
      data: {
        projectId: project.id,
        version: 1,
        actor: 'seed',
        body:
          'JATIN LAW BOOK v4 (2026-10-29) — 43 rules, canonical text: workspace/law/LAW-BOOK.md.\n' +
          'Enforcement: STRUCTURAL at the database · GATE in CI/at write time · REVIEW in the audit flow · HONOUR labelled as such.\n' +
          'Cardinal: no self-approval · falsify, do not assert · unproven is a real answer · the environment is part of the experiment ·\n' +
          'validate at post, fail open on read · agents propose, humans execute · secrets are write-only · the gate that never goes red is refused.',
      },
    });
    await prisma.project.update({ where: { id: project.id }, data: { activeRulesetVersion: 1 } });
    console.log('seeded ruleset v1 (law book v4 pinned)');
  }

  // 5 · seed events so the stream has a readback row (Phase 0 acceptance)
  const orgEvents = await prisma.event.count({ where: { scopeId: org.id } });
  if (orgEvents === 0) {
    await prisma.event.create({
      data: {
        scopeId: org.id,
        seq: 1n,
        type: 'system',
        actor: 'seed',
        body: { what: 'org seeded', note: 'one identity, one bill, one system' },
      },
    });
  }
  const projectEvents = await prisma.event.count({ where: { scopeId: project.id } });
  if (projectEvents === 0) {
    await prisma.event.create({
      data: {
        scopeId: project.id,
        projectId: project.id,
        seq: 1n,
        type: 'system',
        actor: 'seed',
        body: { what: 'project seeded', slug: project.slug },
      },
    });
  }

  console.log('seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
