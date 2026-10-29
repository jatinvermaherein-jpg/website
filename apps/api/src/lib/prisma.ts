import { PrismaClient } from '@prisma/client';

// Runtime connects as the restricted role (APP_DATABASE_URL → jatin_app) so
// the append-only grants structurally bind the hot path. Falls back to
// DATABASE_URL when no app URL is set (e.g. tests with a scratch DB).
export const prisma = new PrismaClient(
  process.env.APP_DATABASE_URL
    ? { datasources: { db: { url: process.env.APP_DATABASE_URL } } }
    : undefined,
);
