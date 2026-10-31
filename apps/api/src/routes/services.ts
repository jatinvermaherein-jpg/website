// SERVICES — the other two faces of the same gateway: web search + image.
// One gateway key (jkn_…) calls all three: /chat/completions (text),
// /search, /image. The customer sees the services by their own names —
// "search", "image" — and NEVER the providers behind the pool.
//
//   search ladder:  tavily → serper (the operator's keys; a customer org's
//                   own BYO search keys come first, like the text pool)
//   image:          pollinations' keyless endpoint
//
// Every call writes a Request row (category 'search' | 'image') so the
// operator's per-model + account limits meter all three services into one
// usage face per account.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { decryptSecret } from '../lib/vault.js';
import { SEARCH_PROVIDERS, IMAGE_PROVIDERS, serviceBase } from '../lib/upstream.js';
import { orgWindows, isSpendable, exhaustion } from '../lib/quota.js';
import { resolveCaller, poolFor, operatorOrgId } from './flow.js';

const UPSTREAM_TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 60_000;

interface ServiceTarget {
  provider: string;
  path: string;
  call: (secret: string, body: Record<string, unknown>) => Promise<Response>;
  normalize: (j: Record<string, unknown>) => { title: string; url: string; snippet: string }[];
}

const SEARCH_TARGETS: ServiceTarget[] = [
  {
    provider: 'tavily',
    path: '/search',
    call: (secret, body) =>
      fetch(`${serviceBase('tavily')}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ query: body.query, max_results: body.maxResults ?? 5 }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }),
    normalize: (j) =>
      ((j.results as { title?: string; url?: string; content?: string }[]) ?? [])
        .slice(0, 8)
        .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: (r.content ?? '').slice(0, 400) })),
  },
  {
    provider: 'serper',
    path: '/serper',
    call: (secret, body) =>
      fetch(`${serviceBase('serper')}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': secret },
        body: JSON.stringify({ q: body.query, num: Math.min(20, (body.maxResults as number) ?? 5) }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }),
    normalize: (j) =>
      ((j.organic as { title?: string; link?: string; snippet?: string }[]) ?? [])
        .slice(0, 8)
        .map((r) => ({ title: r.title ?? '', url: r.link ?? '', snippet: (r.snippet ?? '').slice(0, 400) })),
  },
];

async function withCooldown(credentialId: string) {
  await prisma.providerCredential
    .update({ where: { id: credentialId }, data: { status: 'cooldown', cooldownUntil: new Date(Date.now() + COOLDOWN_MS) } })
    .catch(() => {});
}

export async function serviceRoutes(app: FastifyInstance) {
  // ── web search ────────────────────────────────────────────────────────
  app.post('/search', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsed = z
      .object({
        query: z.string().min(1).max(1000),
        maxResults: z.number().int().min(1).max(20).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: 'invalid search' });
    const body = parsed.data;

    // the ACCOUNT gate, scoped to the 'search' model face
    const orgWins = await orgWindows(prisma, caller.orgId, 'search');
    if (!isSpendable(orgWins)) {
      const dead = orgWins.filter((w) => w.headroom <= 0);
      const retryAfter = Math.max(1, Math.ceil(Math.min(...dead.map((w) => w.msUntilReset)) / 1000));
      return reply.code(429).send({
        error: caller.detailed
          ? `account limit — ${exhaustion(orgWins)}`
          : `usage limit reached for this account (search); resets in ~${retryAfter}s`,
        retry_after_s: retryAfter,
      });
    }

    const requestId = randomUUID();
    const opOrg = caller.detailed ? caller.orgId : (await operatorOrgId());
    const startedAt = Date.now();
    let lastError = 'all search targets failed';

    for (const target of SEARCH_TARGETS) {
      let pool = await poolFor(caller.orgId, target.provider);
      let foreign = false;
      if (!pool.length && opOrg && opOrg !== caller.orgId) {
        pool = await poolFor(opOrg, target.provider);
        foreign = pool.length > 0;
      }
      if (!pool.length) {
        if (SEARCH_TARGETS.length === 1) {
          return caller.detailed
            ? reply.code(409).send({ error: `no active ${target.provider} key on this account — add one in the dashboard` })
            : reply.code(503).send({ error: 'service currently unavailable — try again later' });
        }
        lastError = caller.detailed ? `${target.provider}: no active key` : 'no capacity';
        continue;
      }

      const credential = pool[0]!; // one search key per provider is the unit
      const secret = credential.secretStored
        ? decryptSecret(credential.secretStored, { prisma, actor: caller.actor, action: 'flow.search', target: credential.id })
        : '';
      const finish = (status: string, servedBy: string, wasDegraded: boolean) =>
        prisma.request
          .create({
            data: {
              id: requestId,
              idempotencyKey: randomUUID(),
              orgId: caller.orgId,
              credentialId: credential.id,
              apiKeyId: caller.apiKeyId ?? null,
              source: 'flow',
              category: 'search',
              modelRequested: 'search',
              modelServed: servedBy,
              status,
              degraded: wasDegraded,
              latencyMs: Date.now() - startedAt,
            },
          })
          .catch((e) => console.error('[services] request row failed', e));

      let res: Response;
      try {
        res = await target.call(secret, body);
      } catch {
        await withCooldown(credential.id);
        await finish('error', target.provider, false);
        lastError = caller.detailed ? `network error talking to ${target.provider}` : 'upstream error';
        continue;
      }
      if (!res.ok) {
        await withCooldown(credential.id);
        await finish('error', target.provider, false);
        lastError = caller.detailed ? `${target.provider} ${res.status}` : 'upstream error';
        await res.text().catch(() => {});
        continue;
      }
      const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!j) {
        await finish('error', target.provider, false);
        lastError = 'upstream returned non-JSON';
        continue;
      }
      await finish('ok', target.provider, false);
      return {
        results: target.normalize(j),
        _jatin: { request_id: requestId },
      };
    }

    return reply.code(502).send({
      error: caller.detailed ? `all search targets failed — ${lastError}` : 'upstream error — try again later',
    });
  });

  // ── image ─────────────────────────────────────────────────────────────
  app.post('/image', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsed = z
      .object({
        prompt: z.string().min(1).max(600),
        width: z.number().int().min(256).max(2048).optional(),
        height: z.number().int().min(256).max(2048).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: 'invalid image request' });
    const { prompt, width, height } = parsed.data;

    const orgWins = await orgWindows(prisma, caller.orgId, 'image');
    if (!isSpendable(orgWins)) {
      const dead = orgWins.filter((w) => w.headroom <= 0);
      const retryAfter = Math.max(1, Math.ceil(Math.min(...dead.map((w) => w.msUntilReset)) / 1000));
      return reply.code(429).send({
        error: caller.detailed
          ? `account limit — ${exhaustion(orgWins)}`
          : `usage limit reached for this account (image); resets in ~${retryAfter}s`,
        retry_after_s: retryAfter,
      });
    }

    const requestId = randomUUID();
    const opOrg = caller.detailed ? caller.orgId : (await operatorOrgId());
    const startedAt = Date.now();

    // the image tier is a single provider today — one rung, no ladder
    let pool = await poolFor(caller.orgId, IMAGE_PROVIDERS[0]!);
    let foreign = false;
    if (!pool.length && opOrg && opOrg !== caller.orgId) {
      pool = await poolFor(opOrg, IMAGE_PROVIDERS[0]!);
      foreign = pool.length > 0;
    }
    if (!pool.length) {
      return caller.detailed
        ? reply.code(409).send({ error: `no active ${IMAGE_PROVIDERS[0]} key on this account — add one in the dashboard` })
        : reply.code(503).send({ error: 'service currently unavailable — try again later' });
    }
    const credential = pool[0]!;
    const finish = (status: string, wasDegraded: boolean) =>
      prisma.request
        .create({
          data: {
            id: requestId,
            idempotencyKey: randomUUID(),
            orgId: caller.orgId,
            credentialId: credential.id,
            apiKeyId: caller.apiKeyId ?? null,
            source: 'flow',
            category: 'image',
            modelRequested: 'image',
            modelServed: IMAGE_PROVIDERS[0]!,
            status,
            degraded: wasDegraded,
            latencyMs: Date.now() - startedAt,
          },
        })
        .catch((e) => console.error('[services] request row failed', e));

    const url = `${serviceBase(IMAGE_PROVIDERS[0]!)}/image/${encodeURIComponent(prompt)}?width=${width ?? 1024}&height=${height ?? 1024}&nologo=true`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS * 2) });
    } catch {
      await withCooldown(credential.id);
      await finish('error', false);
      return reply.code(caller.detailed ? 502 : 502).send({ error: caller.detailed ? 'network error talking to the image tier' : 'upstream error — try again later' });
    }
    if (!res.ok || !res.body) {
      await withCooldown(credential.id);
      await finish('error', false);
      await res.text().catch(() => {});
      return reply.code(502).send({ error: caller.detailed ? `upstream ${res.status}` : 'upstream error — try again later' });
    }
    await finish('ok', false);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...(foreign && !caller.detailed ? {} : {}),
    });
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw.write(value);
      }
    } catch (e) {
      console.error('[services] image stream error', e);
    }
    if (!raw.writableEnded) raw.end();
  });
}
