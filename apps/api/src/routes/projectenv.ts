// PROJECT ENV — the environment a project's agents run inside.
//
// Law 6.3 holds here without exception: a secret is WRITE-ONLY. No read path
// on this router returns a value, in any shape, to anyone — not to the
// operator who set it, not to an admin, not in an error message. What comes
// back is a name, a mask and a timestamp.
//
// The value leaves the vault in exactly one place: crew.ts, at spawn time,
// decrypting into the child's environment. Every decryption is audited.
//
// Routes
//   GET    /api/projects/:slug/env              names + masks (member or seat)
//   PUT    /api/projects/:slug/env/:name        set / rotate (operator)
//   DELETE /api/projects/:slug/env/:name        archive (operator)
//   GET    /api/projects/:slug/env/:name/history prior versions, masked (operator)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser, requireOperator } from '../lib/auth.js';
import { seatFromBearer } from '../lib/seatauth.js';
import { encryptSecret, decryptSecret } from '../lib/vault.js';
import { touchSeat } from '../lib/seatauth.js';

// Uppercase env keys only — this ends up in a process environment, and a
// name like `foo-bar` or `A B` is a silent failure at spawn time.
const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

async function projectFor(slug: string, userId: string) {
  const membership = await prisma.membership.findFirst({ where: { userId } });
  if (!membership) return null;
  return prisma.project.findFirst({ where: { slug, orgId: membership.orgId } });
}

export async function projectEnvRoutes(app: FastifyInstance) {
  // read — names only. Never a value. A seat sees the same list a human does.
  app.get('/:slug/env', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const seat = await seatFromBearer(req);
    let projectId: string | null = null;
    if (seat) {
      const p = await prisma.project.findUnique({ where: { slug } });
      if (p) {
        const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: p.id } } });
        if (joined) projectId = p.id;
      }
    } else {
      const user = await requireUser(req, reply);
      if (!user) return;
      const p = await projectFor(slug, user.id);
      if (!p) return reply.code(404).send({ error: 'no such project' });
      projectId = p.id;
    }
    if (!projectId) return reply.code(404).send({ error: 'no such project for this credential' });

    const rows = await prisma.projectEnv.findMany({ where: { projectId }, orderBy: { name: 'asc' } });
    return {
      project: slug,
      // this is the whole contract: name, mask, when. Not the value.
      env: rows.map((r) => ({
        name: r.name,
        mask: r.keyMask,
        isSecret: r.isSecret,
        seatVisible: r.seatVisible,
        updatedAt: r.updatedAt.toISOString(),
      })),
      note: 'values are write-only over this route. A spawned seat gets them in its process env; a self-joined seat can fetch the ones marked seatVisible at /env/values, audited per value.',
    };
  });

  // write — operator only
  app.put('/:slug/env/:name', async (req, reply) => {
    const user = await requireOperator(req, reply);
    if (!user) return;
    const { slug, name } = req.params as { slug: string; name: string };
    if (!NAME_RE.test(name)) {
      return reply.code(422).send({ error: 'env name must be UPPERCASE_SNAKE (A-Z, 0-9, underscore), 1–64 chars' });
    }
    const parsed = z
      .object({ value: z.string().min(1).max(65536), isSecret: z.boolean().optional(), seatVisible: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid env value' });

    const project = await projectFor(slug, user.id);
    if (!project) return reply.code(404).send({ error: 'no such project' });

    const enc = encryptSecret(parsed.data.value);
    const existing = await prisma.projectEnv.findUnique({ where: { projectId_name: { projectId: project.id, name } } });

    if (!existing) {
      const created = await prisma.projectEnv.create({
        data: {
          projectId: project.id,
          name,
          valueStored: enc.stored,
          keyMask: enc.keyMask,
          isSecret: parsed.data.isSecret ?? true,
          seatVisible: parsed.data.seatVisible ?? false,
        },
      });
      await prisma.envVersion.create({
        data: { envId: created.id, version: 1, valueStored: enc.stored, actor: user.username },
      });
      return reply.code(201).send({ name, mask: enc.keyMask, version: 1, created: true, seatVisible: created.seatVisible });
    }

    // rotate — the old value stays in EnvVersion as an immutable record
    const last = await prisma.envVersion.findFirst({ where: { envId: existing.id }, orderBy: { version: 'desc' } });
    const version = (last?.version ?? 0) + 1;
    await prisma.projectEnv.update({
      where: { id: existing.id },
      data: {
        valueStored: enc.stored,
        keyMask: enc.keyMask,
        updatedAt: new Date(),
        // omitted means "leave it as it was" — rotating a value must not
        // silently change who can read it
        ...(parsed.data.seatVisible === undefined ? {} : { seatVisible: parsed.data.seatVisible }),
      },
    });
    await prisma.envVersion.create({
      data: { envId: existing.id, version, valueStored: enc.stored, actor: user.username },
    });
    return { name, mask: enc.keyMask, version, created: false, seatVisible: parsed.data.seatVisible ?? existing.seatVisible };
  });

  // archive — remove the name from future spawns; the history stays
  // ── the values, for the seat that is standing in for you ────────────────
  // The brief carries NAMES. This carries VALUES, and only for the variables
  // the operator has explicitly opened to seats (`seatVisible`). It is the
  // difference between onboarding and theatre: an agent told there is a
  // DATABASE_URL and not given one cannot do the work.
  //
  // Every value handed over is written to the audit log individually, with
  // the seat's name — the same contract as the crew spawn path. A seat may
  // only fetch for a project it is actually on.
  app.get('/:slug/env/values', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const seat = await seatFromBearer(req);
    if (!seat) {
      return reply.code(403).send({ error: 'env values are handed to a seat, not to a session — send the seat key' });
    }
    const project = await prisma.project.findUnique({ where: { slug } });
    if (!project) return reply.code(404).send({ error: 'no such project' });
    const joined = await prisma.seatProject.findUnique({ where: { seatId_projectId: { seatId: seat.id, projectId: project.id } } });
    if (!joined) return reply.code(404).send({ error: 'no such project for this seat' });
    if (!seat.admittedAt) {
      return reply.code(409).send({ error: `seat "${seat.name}" has not admitted itself`, rule: 'D3' });
    }
    touchSeat(seat.id);

    const rows = await prisma.projectEnv.findMany({ where: { projectId: project.id, seatVisible: true }, orderBy: { name: 'asc' } });
    const values: Record<string, string> = {};
    const withheld: string[] = [];
    for (const row of rows) {
      try {
        values[row.name] = decryptSecret(row.valueStored, {
          prisma,
          actor: seat.name,
          action: 'env.inject',
          target: `${project.slug}/${row.name}`,
        });
      } catch (e) {
        // a value that cannot be decrypted must not silently look empty
        withheld.push(row.name);
        console.error(`[env] ${row.name} could not be decrypted for seat ${seat.name}`, e);
      }
    }
    // names that exist but were NOT opened to seats — so the agent knows the
    // difference between "not set" and "not yours"
    const closed = await prisma.projectEnv.findMany({ where: { projectId: project.id, seatVisible: false }, select: { name: true } });
    return {
      project: project.slug,
      seat: seat.name,
      values,
      notOpenedToSeats: closed.map((c) => c.name),
      ...(withheld.length ? { couldNotDecrypt: withheld } : {}),
    };
  });

  app.delete('/:slug/env/:name', async (req, reply) => {
    const user = await requireOperator(req, reply);
    if (!user) return;
    const { slug, name } = req.params as { slug: string; name: string };
    const project = await projectFor(slug, user.id);
    if (!project) return reply.code(404).send({ error: 'no such project' });
    const row = await prisma.projectEnv.findUnique({ where: { projectId_name: { projectId: project.id, name } } });
    if (!row) return reply.code(404).send({ error: 'no such env var' });
    await prisma.projectEnv.delete({ where: { id: row.id } });
    return { name, deleted: true, note: 'the EnvVersion history remains — a rotation trail is not a deletion trail' };
  });

  // history — versions, masks, who and when. Still no values.
  app.get('/:slug/env/:name/history', async (req, reply) => {
    const user = await requireOperator(req, reply);
    if (!user) return;
    const { slug, name } = req.params as { slug: string; name: string };
    const project = await projectFor(slug, user.id);
    if (!project) return reply.code(404).send({ error: 'no such project' });
    const row = await prisma.projectEnv.findUnique({ where: { projectId_name: { projectId: project.id, name } } });
    if (!row) return reply.code(404).send({ error: 'no such env var' });
    const versions = await prisma.envVersion.findMany({ where: { envId: row.id }, orderBy: { version: 'desc' } });
    return {
      name,
      versions: versions.map((v) => ({ version: v.version, actor: v.actor, at: v.ts.toISOString() })),
      note: 'prior values are retained encrypted for audit; none is readable over the API',
    };
  });
}
