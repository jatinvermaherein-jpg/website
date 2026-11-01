// PROJECT DOCUMENTS — versioned rules, specs and attachments.
//
// APPEND-ONLY. A new version supersedes the old one; nothing is ever
// overwritten or deleted. An agent reads the index on its brief, decides
// what it needs, and pulls one document by slug — so a 40 KB spec does not
// ride on every poll of the bus.
//
// Every version carries a sha256 of its body, so an agent can verify that
// what it received is what the project published. That is the same
// discipline as the verdict law: do not trust a claim, check a digest.
//
// Routes
//   GET  /api/projects/:slug/docs                    index (latest per slug)
//   GET  /api/projects/:slug/docs/:docSlug[?version] one body + its sha256
//   POST /api/projects/:slug/docs                    publish a new version
//   POST /api/projects/:slug/docs/:docSlug/archive   retire a slug
//
// Read: any member, or any seat on the project.
// Write: operator, or an ADMITTED seat whose role is lead or scribe.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { seatFromBearer, touchSeat } from '../lib/seatauth.js';
import { appendQuietly } from '../lib/append.js';

const KINDS = ['rules', 'doc', 'attachment', 'reference'] as const;
const WRITER_ROLES = new Set(['lead', 'scribe']);

export const docSha = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

type Ctx = { projectId: string; slug: string; actor: string; canWrite: boolean };

async function resolveCtx(
  req: Parameters<typeof seatFromBearer>[0] & { params: unknown },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): Promise<Ctx | null> {
  const slug = (req.params as { slug: string }).slug;
  const seat = await seatFromBearer(req);
  if (seat) {
    const p = await prisma.project.findUnique({ where: { slug } });
    if (!p) return reply.code(404).send({ error: 'no such project' }) as never;
    const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: p.id } } });
    if (!joined) return reply.code(404).send({ error: 'no such project for this seat' }) as never;
    touchSeat(seat.id);
    return {
      projectId: p.id,
      slug: p.slug,
      actor: seat.name,
      canWrite: seat.admittedAt !== null && WRITER_ROLES.has(seat.role),
    };
  }
  const user = await requireUser(req as never, reply as never);
  if (!user) return null;
  const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!membership) return reply.code(404).send({ error: 'no org' }) as never;
  const p = await prisma.project.findFirst({ where: { slug, orgId: membership.orgId } });
  if (!p) return reply.code(404).send({ error: 'no such project' }) as never;
  return { projectId: p.id, slug: p.slug, actor: user.username, canWrite: true };
}

export async function docRoutes(app: FastifyInstance) {
  // index — the latest version of every live slug, never the bodies
  app.get('/:slug/docs', async (req, reply) => {
    const ctx = await resolveCtx(req as never, reply as never);
    if (!ctx) return;

    const all = await prisma.projectDoc.findMany({
      where: { projectId: ctx.projectId, archivedAt: null },
      orderBy: [{ slug: 'asc' }, { version: 'desc' }],
    });
    const latest = new Map<string, (typeof all)[number]>();
    for (const d of all) if (!latest.has(d.slug)) latest.set(d.slug, d);

    return {
      project: ctx.slug,
      docs: [...latest.values()].map((d) => ({
        slug: d.slug,
        kind: d.kind,
        title: d.title,
        version: d.version,
        mime: d.mime,
        bytes: d.bytes,
        sha256: d.contentHash,
        actor: d.actor,
        updatedAt: d.ts.toISOString(),
      })),
      note: 'append-only — every publish is a new version; fetch a body by slug',
    };
  });

  // one body, by slug, optionally pinned to a version
  app.get('/:slug/docs/:docSlug', async (req, reply) => {
    const ctx = await resolveCtx(req as never, reply as never);
    if (!ctx) return;
    const { docSlug } = req.params as { slug: string; docSlug: string };
    const q = req.query as { version?: string };

    let version: number | undefined;
    if (q.version !== undefined) {
      if (!/^\d+$/.test(q.version)) return reply.code(422).send({ error: 'version must be a positive integer' });
      version = Number(q.version);
    }

    const doc = await prisma.projectDoc.findFirst({
      where: { projectId: ctx.projectId, slug: docSlug, ...(version ? { version } : { archivedAt: null }) },
      orderBy: { version: 'desc' },
    });
    if (!doc) return reply.code(404).send({ error: `no document "${docSlug}"${version ? ` at version ${version}` : ''}` });

    // fail closed on a tampered body — the digest is the point
    const actual = docSha(doc.body);
    const intact = actual === doc.contentHash;

    return {
      slug: doc.slug,
      kind: doc.kind,
      title: doc.title,
      version: doc.version,
      mime: doc.mime,
      bytes: doc.bytes,
      sha256: doc.contentHash,
      intact,
      actor: doc.actor,
      at: doc.ts.toISOString(),
      body: doc.body,
    };
  });

  // publish a new version
  app.post('/:slug/docs', async (req, reply) => {
    const ctx = await resolveCtx(req as never, reply as never);
    if (!ctx) return;
    if (!ctx.canWrite) {
      return reply.code(403).send({
        error: 'publishing project documents needs the operator, or an admitted seat with role lead or scribe',
        rule: 'D3: admission before authority',
      });
    }

    const parsed = z
      .object({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'slug must be lowercase-kebab'),
        title: z.string().min(1).max(160),
        kind: z.enum(KINDS).default('doc'),
        body: z.string().min(1).max(2_000_000),
        mime: z.string().max(120).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid document' });

    const { slug: docSlug, title, kind, body } = parsed.data;
    const mime = parsed.data.mime ?? (kind === 'attachment' ? 'application/octet-stream' : 'text/markdown');

    const existing = await prisma.projectDoc.findMany({ where: { projectId: ctx.projectId, slug: docSlug }, orderBy: { version: 'desc' } });
    const latest = existing[0];
    const version = (latest?.version ?? 0) + 1;
    const hash = docSha(body);

    // same body as the current version is not a new version — say so instead
    // of writing a duplicate into an append-only record.
    if (latest && latest.contentHash === hash) {
      return reply.code(200).send({ slug: docSlug, version: latest.version, unchanged: true, sha256: hash });
    }

    const created = await prisma.projectDoc.create({
      data: {
        projectId: ctx.projectId,
        slug: docSlug,
        kind,
        title,
        version,
        body,
        mime,
        bytes: Buffer.byteLength(body, 'utf8'),
        contentHash: hash,
        actor: ctx.actor,
      },
    });

    // a rules document also advances the project's ruleset, so
    // Project.activeRulesetVersion keeps meaning something
    if (kind === 'rules') {
      await prisma.ruleset.create({ data: { projectId: ctx.projectId, version, body, actor: ctx.actor } }).catch(() => {});
      await prisma.project.update({ where: { id: ctx.projectId }, data: { activeRulesetVersion: version } }).catch(() => {});
    }

    // the bus learns a document changed — that is how an agent knows to re-read
    await appendQuietly({
      projectId: ctx.projectId,
      type: 'system',
      actor: ctx.actor,
      body: { doc: docSlug, kind, version, sha256: hash, title, changed: 'document' },
    });

    return reply.code(201).send({
      slug: created.slug,
      version: created.version,
      bytes: created.bytes,
      sha256: created.contentHash,
    });
  });

  // retire a slug
  app.post('/:slug/docs/:docSlug/archive', async (req, reply) => {
    const ctx = await resolveCtx(req as never, reply as never);
    if (!ctx) return;
    if (!ctx.canWrite) return reply.code(403).send({ error: 'archiving needs the operator, or an admitted lead/scribe seat' });
    const { docSlug } = req.params as { slug: string; docSlug: string };
    const res = await prisma.projectDoc.updateMany({
      where: { projectId: ctx.projectId, slug: docSlug, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (res.count === 0) return reply.code(404).send({ error: `no live document "${docSlug}"` });
    return { slug: docSlug, archived: true, versions: res.count, note: 'every version is retained — archive is a tombstone, not a delete' };
  });
}
