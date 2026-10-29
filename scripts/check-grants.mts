/**
 * Law 2.2 / V4 §10 — STRUCTURAL: append-only tables carry no UPDATE/DELETE
 * grant for the application role. Enforced in the database, not the app.
 * Law 5.5 — positive reporting: prints PASS with a count and a timestamp;
 * absence of this output is treated as failure by CI.
 *
 *   DATABASE_URL=... npx tsx scripts/check-grants.ts [role]   (default jatin_app)
 */
import { PrismaClient } from '@prisma/client';

const role = process.argv[2] ?? 'jatin_app';
const prisma = new PrismaClient();

try {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n
       FROM information_schema.table_privileges
      WHERE grantee = '${role.replaceAll("'", "''")}'
        AND table_schema = 'public'
        AND table_name IN ('Event','Verdict','LedgerRow','Handover','Ruleset','EnvVersion','Breach','AuditLog')
        AND privilege_type IN ('UPDATE','DELETE');`,
  );
  const n = rows[0]?.n ?? -1;
  if (n !== 0) {
    console.error(`FAIL grants-gate: ${n} UPDATE/DELETE grant(s) on append-only tables for role ${role}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS grants-gate 0 violations ${new Date().toISOString()}`);
  }

  // positive tier: the working tables must be fully writable (a grant
  // regression in EITHER direction is a failure)
  const pos = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n
       FROM information_schema.table_privileges
      WHERE grantee = '${role.replaceAll("'", "''")}'
        AND table_schema = 'public'
        AND table_name IN ('User','ApiKey','ProviderCredential','KeyLimit','Cursor','Verification')
        AND privilege_type IN ('UPDATE','DELETE');`,
  );
  const pn = pos[0]?.n ?? 0;
  if (pn !== 12) {
    console.error(`FAIL grants-gate: only ${pn}/12 mutable-tier DML grants present for role ${role}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS grants-gate mutable-tier 12/12 ${new Date().toISOString()}`);
  }
} finally {
  await prisma.$disconnect();
}
