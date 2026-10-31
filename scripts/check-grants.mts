/**
 * Law 2.2 / V4 §10 — STRUCTURAL: append-only tables carry no UPDATE/DELETE
 * grant for the application role. Enforced in the database, not the app.
 * Law 5.5 — positive reporting: prints PASS with a count and a timestamp;
 * absence of this output is treated as failure by CI.
 *
 *   DATABASE_URL=... npx tsx scripts/check-grants.mts [role]   (default jatin_app)
 *
 * m1 — no typed counts: the expected grants are computed from the two
 * policy lists below, and every model in the schema must be classified in
 * one of them (a new model forces an explicit decision — fail closed).
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const role = process.argv[2] ?? 'jatin_app';

// THE LAW — explicit policy, not measurement. A table is in exactly one list.
const APPEND_ONLY = [
  'Event', 'Verdict', 'LedgerRow', 'Handover', 'Ruleset', 'EnvVersion', 'Breach', 'AuditLog',
];
// 0002's mutable tier: full DML. New tables default to append-only until
// someone grants them up AND classifies them here.
const MUTABLE = [
  'ApiKey', 'Artifact', 'BenchManifest', 'Cursor', 'KeyLimit', 'Membership',
  'Model', 'ModelAlias', 'ModelSighting', 'Org', 'OrgLimit', 'Project', 'ProjectEnv',
  'ProjectModelRoute', 'ProviderCredential', 'QuotaWindow', 'Request', 'Seat',
  'SeatKey', 'SeatProject', 'Session', 'Task', 'UsageRollup', 'User', 'Verification', 'Waiver',
];

const models = new Set(
  readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^model\s+(\w+)/.exec(l)?.[1])
    .filter((m): m is string => Boolean(m)),
);

const sql = (names: string[]) => names.map((t) => `'${t}'`).join(', ');

const prisma = new PrismaClient();
let failed = false;

try {
  // 1) append-only law: zero UPDATE/DELETE grants on the 8 evidence/ledger tables
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM information_schema.table_privileges
      WHERE grantee = '${role.replaceAll("'", "''")}' AND table_schema = 'public'
        AND table_name IN (${sql(APPEND_ONLY)}) AND privilege_type IN ('UPDATE','DELETE');`,
  );
  const n = rows[0]?.n ?? -1;
  if (n !== 0) {
    console.error(`FAIL grants-gate: ${n} UPDATE/DELETE grant(s) on append-only tables for role ${role}`);
    failed = true;
  } else {
    console.log(`PASS grants-gate append-only 0 violations on ${APPEND_ONLY.length} tables ${new Date().toISOString()}`);
  }

  // 2) mutable tier: every working table must hold BOTH grants (48 = 24 x 2, computed)
  const expected = MUTABLE.length * 2;
  const pos = await prisma.$queryRawUnsafe<Array<{ table: string; priv: string }>>(
    `SELECT table_name AS table, privilege_type AS priv FROM information_schema.table_privileges
      WHERE grantee = '${role.replaceAll("'", "''")}' AND table_schema = 'public'
        AND table_name IN (${sql(MUTABLE)}) AND privilege_type IN ('UPDATE','DELETE');`,
  );
  const missing = MUTABLE
    .map((t) => [t, pos.filter((r) => r.table === t).map((r) => r.priv)])
    .filter(([, privs]) => !privs.includes('UPDATE') || !privs.includes('DELETE'))
    .map(([t, privs]) => `${t}(${privs.join(',') || 'none'})`);
  if (pos.length !== expected || missing.length > 0) {
    console.error(`FAIL grants-gate: mutable tier ${pos.length}/${expected} DML grants for role ${role}; missing: ${missing.join(' ') || 'count drift'}`);
    failed = true;
  } else {
    console.log(`PASS grants-gate mutable-tier ${expected}/${expected} across ${MUTABLE.length} tables ${new Date().toISOString()}`);
  }

  // 3) coverage: every model in the schema is classified (fail closed)
  const unclassified = [...models].filter((m) => !APPEND_ONLY.includes(m) && !MUTABLE.includes(m));
  const stale = [...APPEND_ONLY, ...MUTABLE].filter((t) => !models.has(t));
  if (unclassified.length > 0 || stale.length > 0) {
    console.error(`FAIL grants-gate: schema drift — unclassified models: ${unclassified.join(', ') || 'none'}; listed but absent: ${stale.join(', ') || 'none'}`);
    failed = true;
  } else {
    console.log(`PASS grants-gate coverage ${models.size}/${models.size} models classified ${new Date().toISOString()}`);
  }

  if (failed) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
