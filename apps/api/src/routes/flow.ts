// FLOW — the gateway.
//   Phase 1: one provider, streaming, real token counts.
//   Phase 2: multi-key pool — a key that dies does not kill the request.
//     Failover ladder (same provider, next key):
//       401/403  → key marked `dead`   (structural — out of the pool forever)
//       429/5xx/network → key `cooldown` 60s
//       other 4xx → the request itself is invalid: surface it, penalise no key
//     The attempt that serves the response is recorded as `fallback` +
//     degraded:true when it was not the first (degradation is flagged, never
//     silent). Every attempt gets its own Request row — the trail is the
//     record.
// OpenAI-compatible surface: POST /api/flow/chat/completions.
//   model = "<provider>/<provider-model-id>"
// Token counts are the provider's own numbers (stream usage chunk / final
// usage). Provider silent → status `provider-silent` — never an estimate.
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { decryptSecret } from '../lib/vault.js';
import { TEXT_PROVIDERS, upstreamBase } from '../lib/upstream.js';
import { keyWindows, isSpendable, urgency, exhaustion } from '../lib/quota.js';

const UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const COOLDOWN_MS = 60_000;

const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string().min(1), content: z.unknown() }).passthrough()).min(1),
    stream: z.boolean().optional().default(true),
  })
  .passthrough();

type Usage = { tokensIn: number; tokensOut: number; source: 'provider' | 'provider-silent' };

function splitModel(model: string): { provider: string; providerModelId: string } | null {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  const provider = model.slice(0, i);
  const providerModelId = model.slice(i + 1);
  return TEXT_PROVIDERS.includes(provider) ? { provider, providerModelId } : null;
}

// pool = active keys + cooldown keys whose window has passed (they revive
// without any write)
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

export async function flowRoutes(app: FastifyInstance) {
  app.post('/chat/completions', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;

    const parsed = chatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    }
    const body = parsed.data;
    const split = splitModel(body.model);
    if (!split) {
      return reply
        .code(400)
        .send({ error: `model must be "<provider>/<model-id>" — provider one of: ${TEXT_PROVIDERS.join(', ')}` });
    }
    const { provider, providerModelId } = split;

    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });

    const pool = await poolFor(membership.orgId, provider);
    if (!pool.length) {
      return reply.code(409).send({ error: `no active ${provider} key on this account — add one in the dashboard` });
    }

    // Phase 3 — use-it-or-lose-it: rank the pool by urgency (headroom vs
    // time-to-reset, measured from the ledger). The key whose quota dies
    // soonest is spent first.
    const ranked = (
      await Promise.all(pool.map(async (c) => ({ c, windows: await keyWindows(prisma, c.id) })))
    ).sort((a, b) => urgency(b.windows) - urgency(a.windows));
    const spendable = ranked.filter((r) => isSpendable(r.windows));
    if (!spendable.length) {
      const reasons = [...new Set(ranked.map((r) => exhaustion(r.windows)).filter(Boolean))] as string[];
      const soonestMs = Math.min(...ranked.flatMap((r) => r.windows.map((w) => w.msUntilReset)));
      return reply.code(429).send({
        error: `all ${provider} keys are at their quota limit — ${reasons.join(' · ')}`,
        retry_after_s: Math.max(1, Math.ceil(soonestMs / 1000)),
      });
    }

    const baseIdempotency = (req.headers['idempotency-key'] as string) || randomUUID();
    const startedAt = Date.now();
    let lastError = `all ${provider} keys failed`;

    for (let attempt = 0; attempt < spendable.length; attempt++) {
      const credential = spendable[attempt]!.c;
      const requestId = randomUUID();
      await prisma.request.create({
        data: {
          id: requestId,
          idempotencyKey: `${baseIdempotency}#${attempt + 1}`,
          orgId: membership.orgId,
          credentialId: credential.id,
          source: 'flow',
          modelRequested: body.model,
          modelServed: body.model,
        },
      });
      const finish = (status: string, usage: Usage, degraded: boolean) =>
        prisma.request
          .update({
            where: { id: requestId },
            data: {
              status,
              tokensIn: usage.tokensIn,
              tokensOut: usage.tokensOut,
              latencyMs: Date.now() - startedAt,
              degraded,
            },
          })
          .catch((e) => console.error('[flow] request row update failed', e));

      const secret = decryptSecret(credential.secretStored, {
        prisma,
        actor: user.username,
        action: 'flow.upstream',
        target: credential.id,
      });

      const upstreamBody: Record<string, unknown> = {
        ...body,
        model: providerModelId,
        stream: body.stream ?? true,
      };
      if (upstreamBody.stream) upstreamBody.stream_options = { include_usage: true };

      const doUpstream = (withStreamOptions: boolean) =>
        fetch(`${upstreamBase(provider)}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${secret}`,
            ...(provider === 'openrouter' ? { 'http-referer': 'https://jatin.local', 'x-title': 'Jatin' } : {}),
          },
          body: JSON.stringify(withStreamOptions ? upstreamBody : { ...upstreamBody, stream_options: undefined }),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });

      let res: Response;
      try {
        res = await doUpstream(true).catch(async () => doUpstream(false));
      } catch (e) {
        // network-level failure — penalise, try the next key
        await prisma.providerCredential
          .update({ where: { id: credential.id }, data: { status: 'cooldown', cooldownUntil: new Date(Date.now() + COOLDOWN_MS) } })
          .catch(() => {});
        await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, true);
        lastError = `network error talking to ${provider}: ${(e as Error).message}`;
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
        lastError = `upstream ${provider} ${res.status}: ${message}`;

        if (res.status === 401 || res.status === 403) {
          // the key itself is wrong — structural retirement
          await prisma.providerCredential.update({ where: { id: credential.id }, data: { status: 'dead' } }).catch(() => {});
        } else if (res.status === 429 || res.status >= 500) {
          await prisma.providerCredential
            .update({ where: { id: credential.id }, data: { status: 'cooldown', cooldownUntil: new Date(Date.now() + COOLDOWN_MS) } })
            .catch(() => {});
        } else {
          // a 4xx that is not about the key (400 bad request, 404 model…) —
          // failing over would just burn the pool; surface it now.
          await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, false);
          return reply.code(res.status).send({ error: lastError });
        }
        await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, true);
        continue;
      }

      // ── the attempt that serves the response ─────────────────────────
      const degraded = attempt > 0;

      if (upstreamBody.stream) {
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(res.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-request-id': requestId,
          ...(degraded ? { 'x-jatin-degraded': '1' } : {}),
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
          raw.end();
        } catch (e) {
          if (!raw.writableEnded) raw.end();
          console.error('[flow] stream error', e);
          return;
        }
        await finish(degraded ? 'fallback' : 'ok', usage, degraded);
        return;
      }

      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!json) {
        await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' }, degraded);
        return reply.code(502).send({ error: 'upstream returned non-JSON' });
      }
      const u = json?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      const usage: Usage =
        u && typeof u.prompt_tokens === 'number'
          ? { tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens ?? 0, source: 'provider' }
          : { tokensIn: 0, tokensOut: 0, source: 'provider-silent' };
      await finish(degraded ? 'fallback' : 'ok', usage, degraded);
      return {
        ...json,
        _jatin: {
          request_id: requestId,
          usage_source: usage.source,
          ...(degraded ? { degraded: true, reason: lastError } : {}),
        },
      };
    }

    // the whole pool failed — the client sees the last real error
    return reply.code(502).send({ error: lastError });
  });

  // what did my account spend (per key, per model)? — the read side of
  // "every number on screen is measured".
  app.get('/usage', async (req, reply) => {
    const user = await requireUser(req, reply);
    if (!user) return;
    const membership = await prisma.membership.findFirst({ where: { userId: user.id } });
    if (!membership) return reply.code(404).send({ error: 'no org' });
    const requests = await prisma.request.findMany({
      where: { orgId: membership.orgId, source: 'flow' },
      select: {
        id: true,
        credentialId: true,
        modelRequested: true,
        tokensIn: true,
        tokensOut: true,
        status: true,
        degraded: true,
        latencyMs: true,
        createdAt: true,
        credential: { select: { keyMask: true, provider: true, label: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    // the scheduler's live numbers, per key — measured, not estimated
    const creds = await prisma.providerCredential.findMany({
      where: { orgId: membership.orgId, projectId: null, provider: { in: TEXT_PROVIDERS } },
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
    return { requests, keys };
  });
}
