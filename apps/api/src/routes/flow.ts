// FLOW — the gateway.
//   Phase 1: one provider, streaming, real token counts.
//   Phase 2: multi-key pool — a dead key does not kill the request
//     (401/403 → dead, 429/5xx/network → cooldown, other 4xx → surface now).
//   Phase 3: quota scheduler — use-it-or-lose-it urgency ranking, reserve
//     cushion, structured 429 with the exhausted window named.
//   Phase 4: multi-provider — a model reference is either an exact
//     "<provider>/<model-id>" or an org ALIAS (an ordered list of provider
//     targets, ≤4 hops). When the first target is exhausted or dead, the
//     next one serves — and the response CARRIES THE FLAG (degraded header +
//     body field + Request row). Degradation is never silent.
// OpenAI-compatible surface: POST /api/flow/chat/completions.
// Token counts are the provider's own numbers. Provider silent →
// `provider-silent` — never an estimate. Cost is priced from the Model row
// when one exists; unpriced = 0, not a guess.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { decryptSecret } from '../lib/vault.js';
import { TEXT_PROVIDERS, upstreamBase } from '../lib/upstream.js';
import { keyWindows, isSpendable, urgency, exhaustion } from '../lib/quota.js';

const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;
const MAX_HOPS = 4;

// Gateway keys (the key a CLIENT uses to call this gateway, `jkn_…`).
// Law 6.3 — write-only: the plaintext exists exactly once, at creation.
// The row keeps sha256 + a unique prefix for lookup; no read path ever
// returns the key or the hash.
const GK_PREFIX = 'jkn_';
const GK_PREFIX_LEN = 12; // jkn_ + 8 chars of the random part
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

// actor = the vault-audit identity: the user's name, or the gateway key's
// name — the append-only AuditLog must say WHO decrypted which secret.
type Caller = { orgId: string; apiKeyId?: string; actor: string };

// One caller resolution for the whole flow surface: a session JWT
// (dashboard user) or a gateway key (external client). Both land on an org.
async function resolveCaller(req: FastifyRequest, reply: FastifyReply): Promise<Caller | null> {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith(GK_PREFIX)) {
      const key = await prisma.apiKey.findUnique({ where: { prefix: token.slice(0, GK_PREFIX_LEN) } });
      if (!key || key.keyHash !== sha256hex(token)) {
        reply.code(401).send({ error: 'unknown gateway key' });
        return null;
      }
      if (key.revokedAt) {
        reply.code(401).send({ error: 'gateway key revoked' });
        return null;
      }
      return { orgId: key.orgId, apiKeyId: key.id, actor: `key:${key.name}` };
    }
  }
  const user = await requireUser(req, reply);
  if (!user) return null;
  const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
  if (!membership) {
    reply.code(404).send({ error: 'no org' });
    return null;
  }
  return { orgId: membership.orgId, actor: user.username };
}

const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string().min(1), content: z.unknown() }).passthrough()).min(1),
    stream: z.boolean().optional().default(true),
  })
  .passthrough();

type Usage = { tokensIn: number; tokensOut: number; source: 'provider' | 'provider-silent' };

interface Target {
  provider: string;
  providerModelId: string;
}

function splitModel(model: string): Target | null {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  const provider = model.slice(0, i);
  const providerModelId = model.slice(i + 1);
  return TEXT_PROVIDERS.includes(provider) ? { provider, providerModelId } : null;
}

// model reference → ordered targets (≤ MAX_HOPS)
async function resolveTargets(orgId: string, modelRef: string): Promise<{ targets: Target[]; error?: string }> {
  if (modelRef.includes('/')) {
    const t = splitModel(modelRef);
    if (!t) {
      return { targets: [], error: `model must be "<provider>/<model-id>" (provider: ${TEXT_PROVIDERS.join(', ')}) or an org alias` };
    }
    return { targets: [t] };
  }
  const aliases = await prisma.modelAlias.findMany({
    where: { orgId, alias: modelRef },
    orderBy: { priority: 'asc' },
    take: MAX_HOPS,
  });
  if (!aliases.length) {
    return { targets: [], error: `no alias "${modelRef}" on this account — request "<provider>/<model-id>" or create the alias` };
  }
  const models = await prisma.model.findMany({ where: { id: { in: aliases.map((a) => a.modelId) } } });
  const byId = new Map(models.map((m) => [m.id, m]));
  const targets = aliases
    .map((a) => byId.get(a.modelId))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ provider: m.provider, providerModelId: m.providerModelId }));
  if (!targets.length) return { targets: [], error: `alias "${modelRef}" has no resolvable targets` };
  return { targets };
}

// pool = active keys + expired cooldowns (they revive without a write)
async function poolFor(orgId: string, provider: string) {
  const now = new Date();
  return prisma.providerCredential.findMany({
    where: {
      orgId,
      provider,
      projectId: null,
      OR: [{ status: 'active' }, { status: 'cooldown', cooldownUntil: { lt: now } }],
    },
    orderBy: { createdAt: 'asc' },
  });
}

async function priceFor(provider: string, providerModelId: string, usage: Usage): Promise<number> {
  const model = await prisma.model
    .findUnique({ where: { provider_providerModelId: { provider, providerModelId } } })
    .catch(() => null);
  if (!model) return 0;
  return (usage.tokensIn / 1e6) * model.priceInPerM + (usage.tokensOut / 1e6) * model.priceOutPerM;
}

export async function flowRoutes(app: FastifyInstance) {
  app.post('/chat/completions', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;

    const parsed = chatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    }
    const body = parsed.data;

    const { targets, error } = await resolveTargets(caller.orgId, body.model);
    if (error) return reply.code(400).send({ error });

    const baseIdempotency = (req.headers['idempotency-key'] as string) || randomUUID();
    const startedAt = Date.now();
    const quotaWalls: string[] = [];
    const ladderFailures: string[] = [];
    let quotaResetMs = Infinity;
    let lastError = `all targets for "${body.model}" failed`;

    for (let hop = 0; hop < targets.length; hop++) {
      const target = targets[hop]!;

      const pool = await poolFor(caller.orgId, target.provider);
      if (!pool.length) {
        // one target and no key at all → say exactly that (it's an action,
        // not a failure of the ladder); on a ladder it's just a rung that's
        // missing, so the walk continues
        if (targets.length === 1) {
          return reply.code(409).send({ error: `no active ${target.provider} key on this account — add one in the dashboard` });
        }
        const wall = `${target.provider}: no active key`;
        ladderFailures.push(wall);
        lastError = wall;
        continue;
      }

      // Phase 3 — use-it-or-lose-it ranking within the target
      const ranked = (
        await Promise.all(pool.map(async (c) => ({ c, windows: await keyWindows(prisma, c.id) })))
      ).sort((a, b) => urgency(b.windows) - urgency(a.windows));
      const spendable = ranked.filter((r) => isSpendable(r.windows));
      if (!spendable.length) {
        const wall = `${target.provider}: ${[...new Set(ranked.map((r) => exhaustion(r.windows)).filter(Boolean))].join(' · ') || 'no quota'}`;
        quotaWalls.push(wall);
        lastError = wall;
        for (const r of ranked) for (const w of r.windows) quotaResetMs = Math.min(quotaResetMs, w.msUntilReset);
        continue;
      }

      for (let attempt = 0; attempt < spendable.length; attempt++) {
        // a later rung OR a later key within the rung is the degradation —
        // the flag rides the response, the header, and the Request row
        const degraded = hop > 0 || attempt > 0;
        const credential = spendable[attempt]!.c;
        const requestId = randomUUID();
        await prisma.request.create({
          data: {
            id: requestId,
            idempotencyKey: `${baseIdempotency}#h${hop + 1}a${attempt + 1}`,
            orgId: caller.orgId,
            credentialId: credential.id,
            apiKeyId: caller.apiKeyId ?? null,
            source: 'flow',
            modelRequested: body.model,
            modelServed: `${target.provider}/${target.providerModelId}`,
          },
        });
        const finish = (status: string, usage: Usage, costCents: number, wasDegraded: boolean) =>
          prisma.request
            .update({
              where: { id: requestId },
              data: {
                status,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                costCents,
                latencyMs: Date.now() - startedAt,
                degraded: wasDegraded,
              },
            })
            .catch((e) => console.error('[flow] request row update failed', e));

        const secret = decryptSecret(credential.secretStored, {
          prisma,
          actor: caller.actor,
          action: 'flow.upstream',
          target: credential.id,
        });

        const upstreamBody: Record<string, unknown> = {
          ...body,
          model: target.providerModelId,
          stream: body.stream ?? true,
        };
        if (upstreamBody.stream) upstreamBody.stream_options = { include_usage: true };

        const doUpstream = (withStreamOptions: boolean) =>
          fetch(`${upstreamBase(target.provider)}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${secret}`,
              ...(target.provider === 'openrouter' ? { 'http-referer': 'https://jatin.local', 'x-title': 'Jatin' } : {}),
            },
            body: JSON.stringify(withStreamOptions ? upstreamBody : { ...upstreamBody, stream_options: undefined }),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });

        let res: Response;
        try {
          res = await doUpstream(true).catch(async () => doUpstream(false));
        } catch (e) {
          await prisma.providerCredential
            .update({ where: { id: credential.id }, data: { status: 'cooldown', cooldownUntil: new Date(Date.now() + COOLDOWN_MS) } })
            .catch(() => {});
          await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, 0, degraded);
          lastError = `network error talking to ${target.provider}: ${(e as Error).message}`;
          continue;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          let message = `upstream ${res.status}`;
          try {
            const j = JSON.parse(errText);
            message = j?.error?.message ?? j?.message ?? message;
          } catch {
            if (errText) message = errText.slice(0, 400);
          }
          lastError = `upstream ${target.provider} ${res.status}: ${message}`;

          if (res.status === 401 || res.status === 403) {
            await prisma.providerCredential.update({ where: { id: credential.id }, data: { status: 'dead' } }).catch(() => {});
          } else if (res.status === 429 || res.status >= 500) {
            await prisma.providerCredential
              .update({ where: { id: credential.id }, data: { status: 'cooldown', cooldownUntil: new Date(Date.now() + COOLDOWN_MS) } })
              .catch(() => {});
          } else {
            // a 4xx that is not about the key — failing over would just burn
            // the ladder; surface it now.
            await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, 0, false);
            return reply.code(res.status).send({ error: lastError });
          }
          await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, 0, degraded);
          continue;
        }

        // ── the attempt that serves the response ───────────────────────
        if (upstreamBody.stream) {
          reply.hijack();
          const raw = reply.raw;
          raw.writeHead(res.status, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-request-id': requestId,
            ...(degraded ? { 'x-jatin-degraded': '1', 'x-jatin-route': body.model } : {}),
          });
          req.raw.on('close', () => res.body?.cancel?.().catch(() => {}));

          let usage: Usage = { tokensIn: 0, tokensOut: 0, source: 'provider-silent' };
          try {
            const reader = (res.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              raw.write(value);
              buf += decoder.decode(value, { stream: true });
              let nl: number;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                  const j = JSON.parse(payload);
                  if (j?.usage && typeof j.usage.prompt_tokens === 'number') {
                    usage = { tokensIn: j.usage.prompt_tokens, tokensOut: j.usage.completion_tokens ?? 0, source: 'provider' };
                  }
                } catch {
                  /* non-JSON data line — pass through untouched */
                }
            }
          }
        } catch (e) {
          console.error('[flow] stream error', e);
          await finish('error', usage, 0, degraded);
          if (!raw.writableEnded) raw.end();
          return;
        }
        // the trail is durable BEFORE the stream is declared done — the
        // record exists even if the client hangs up on the last byte
        await finish(degraded ? 'fallback' : 'ok', usage, await priceFor(target.provider, target.providerModelId, usage), degraded);
        if (!raw.writableEnded) raw.end();
        return;
      }

        const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!json) {
          await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, 0, degraded);
          return reply.code(502).send({ error: 'upstream returned non-JSON' });
        }
        const u = json?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        const usage: Usage =
          u && typeof u.prompt_tokens === 'number'
            ? { tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens ?? 0, source: 'provider' }
            : { tokensIn: 0, tokensOut: 0, source: 'provider-silent' };
        await finish(degraded ? 'fallback' : 'ok', usage, await priceFor(target.provider, target.providerModelId, usage), degraded);
        return {
          ...json,
          _jatin: {
            request_id: requestId,
            usage_source: usage.source,
            ...(degraded ? { degraded: true, reason: lastError } : {}),
          },
        };
      }
    }

    // the whole ladder failed. Every rung hit a QUOTA wall → structured
    // 429 (retryable, with the wall named and a retry hint). Anything else
    // (missing keys, dead keys, upstream errors) → 502 with the trail.
    if (quotaWalls.length === targets.length && ladderFailures.length === 0) {
      return reply.code(429).send({
        error: `all keys are at their quota limit — ${quotaWalls.join(' · ')}`,
        retry_after_s: Math.max(1, Math.ceil(quotaResetMs / 1000)),
      });
    }
    const allFailures = [...quotaWalls, ...ladderFailures];
    return reply.code(502).send({ error: allFailures.length ? `all targets for "${body.model}" failed — ladder: ${allFailures.join(' → ')}` : lastError });
  });

  // what did my account spend (per key, per model)? — the read side of
  // "every number on screen is measured". Accepts a session (dashboard)
  // or a gateway key (the client's own monitor view of its org's flow).
  app.get('/usage', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;
    const requests = await prisma.request.findMany({
      where: { orgId: caller.orgId, source: 'flow' },
      select: {
        id: true,
        credentialId: true,
        modelRequested: true,
        modelServed: true,
        tokensIn: true,
        tokensOut: true,
        costCents: true,
        status: true,
        degraded: true,
        latencyMs: true,
        createdAt: true,
        credential: { select: { id: true, keyMask: true, provider: true, label: true, status: true } },
        apiKey: { select: { name: true, prefix: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const creds = await prisma.providerCredential.findMany({
      where: { orgId: caller.orgId, projectId: null, provider: { in: TEXT_PROVIDERS } },
    });
    const keys = await Promise.all(
      creds.map(async (c) => ({
        id: c.id,
        provider: c.provider,
        label: c.label,
        keyMask: c.keyMask,
        status: c.status,
        windows: await keyWindows(prisma, c.id),
      })),
    );
    // detailed per-gateway-key usage: every number measured from the ledger
    const gkeys = await prisma.apiKey.findMany({ where: { orgId: caller.orgId }, orderBy: { createdAt: 'asc' } });
    const gatewayKeys = await Promise.all(
      gkeys.map(async (k) => {
        const agg = await prisma.request.aggregate({
          where: { apiKeyId: k.id },
          _count: { _all: true },
          _sum: { tokensIn: true, tokensOut: true, costCents: true },
          _max: { createdAt: true },
        });
        return {
          id: k.id,
          name: k.name,
          prefix: k.prefix,
          createdAt: k.createdAt,
          revokedAt: k.revokedAt,
          requests: agg._count._all,
          tokensIn: agg._sum.tokensIn ?? 0,
          tokensOut: agg._sum.tokensOut ?? 0,
          costCents: agg._sum.costCents ?? 0,
          lastUsedAt: agg._max.createdAt,
        };
      }),
    );
    return { requests, keys, gatewayKeys };
  });

  // ── gateway keys: the key a CLIENT uses to call this gateway ─────────
  // Law 6.3 — write-only. POST returns the plaintext exactly once; GET
  // lists name/prefix/status only; revoke is archive-not-delete (the row
  // and its Request trail stay, the key stops working instantly).

  app.post('/keys', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;
    const parsed = z.object({ name: z.string().min(1).max(80) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid name' });

    // prefix collision is ~impossible (48 bits) but the unique index is the
    // law — retry rather than crash
    let created: { id: string; name: string; prefix: string; createdAt: Date } | null = null;
    let plaintext = '';
    for (let i = 0; i < 5 && !created; i++) {
      plaintext = GK_PREFIX + randomBytes(32).toString('base64url');
      try {
        created = await prisma.apiKey.create({
          data: { orgId: caller.orgId, prefix: plaintext.slice(0, GK_PREFIX_LEN), keyHash: sha256hex(plaintext), name: parsed.data.name },
        });
      } catch {
        /* prefix collision — regenerate */
      }
    }
    if (!created) return reply.code(500).send({ error: 'could not allocate a key prefix' });
    return reply.code(201).send({
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      key: plaintext,
      note: 'shown exactly once — there is no read path that returns this key again',
    });
  });

  app.get('/keys', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;
    const keys = await prisma.apiKey.findMany({ where: { orgId: caller.orgId }, orderBy: { createdAt: 'asc' } });
    return {
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    };
  });

  app.post('/keys/:id/revoke', async (req, reply) => {
    const caller = await resolveCaller(req, reply);
    if (!caller) return;
    const key = await prisma.apiKey.findFirst({ where: { id: (req.params as { id: string }).id, orgId: caller.orgId } });
    if (!key) return reply.code(404).send({ error: 'key not found' });
    if (key.revokedAt) return { id: key.id, status: 'revoked', note: 'already revoked' };
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    return { id: key.id, status: 'revoked' };
  });
}
