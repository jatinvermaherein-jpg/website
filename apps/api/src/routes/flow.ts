// FLOW — the gateway (Phase 1: one provider, streaming, real token counts).
// OpenAI-compatible surface: POST /api/flow/chat/completions.
//   model = "<provider>/<provider-model-id>"  (e.g. "groq/llama-3.3-70b-versatile")
// The org's vaulted key for that provider is decrypted (audited, law 6.3 —
// the plaintext never reaches a read path) and used exactly once, upstream.
// Token counts are the provider's own numbers (stream usage chunk or final
// response usage). If the provider reports no usage, we store null-ish zeros
// with status "provider-silent" — never an estimate (law: no estimates as
// measurements).
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireUser } from '../lib/auth.js';
import { decryptSecret } from '../lib/vault.js';
import { TEXT_PROVIDERS, upstreamBase } from '../lib/upstream.js';

const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

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

    // the org's pool key for this provider (project-scoped routing: O1, later phases)
    const credential = await prisma.providerCredential.findFirst({
      where: { orgId: membership.orgId, provider, projectId: null, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    if (!credential) {
      return reply
        .code(409)
        .send({ error: `no active ${provider} key on this account — add one in the dashboard` });
    }

    const requestId = randomUUID();
    await prisma.request.create({
      data: {
        id: requestId,
        idempotencyKey: (req.headers['idempotency-key'] as string) || randomUUID(),
        orgId: membership.orgId,
        credentialId: credential.id,
        source: 'flow',
        modelRequested: body.model,
        modelServed: body.model,
      },
    });

    const startedAt = Date.now();
    const finish = (status: string, usage: Usage, degraded = false) =>
      prisma.request
        .update({
          where: { id: requestId },
          data: {
            status: usage.source === 'provider-silent' ? 'provider-silent' : status,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            latencyMs: Date.now() - startedAt,
            degraded,
          },
        })
        .catch((e) => console.error('[flow] request row update failed', e));

    const upstreamBody: Record<string, unknown> = {
      ...body,
      model: providerModelId,
      stream: body.stream ?? true,
    };
    if (upstreamBody.stream) upstreamBody.stream_options = { include_usage: true };

    const secret = decryptSecret(credential.secretStored, {
      prisma,
      actor: user.username,
      action: 'flow.upstream',
      target: credential.id,
    });
    const doUpstream = (withStreamOptions: boolean) =>
      fetch(`${upstreamBase(provider)}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secret}`,
          ...(provider === 'openrouter'
            ? { 'http-referer': 'https://jatin.local', 'x-title': 'Jatin' }
            : {}),
        },
        body: JSON.stringify(withStreamOptions ? upstreamBody : { ...upstreamBody, stream_options: undefined }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

    let res = await doUpstream(true).catch(async () => doUpstream(false));

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let message = `upstream ${res.status}`;
      try {
        const j = JSON.parse(errText);
        message = j?.error?.message ?? j?.message ?? message;
      } catch {
        if (errText) message = errText.slice(0, 400);
      }
      await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' });
      return reply.code(res.status).send({ error: `upstream ${provider} ${res.status}: ${message}` });
    }

    if (upstreamBody.stream) {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(res.status, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-request-id': requestId,
      });
      const clientGone = () => res.body?.cancel?.().catch(() => {});
      req.raw.on('close', clientGone);

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
          // parse SSE lines for the provider's usage report (OpenAI style:
          // a data chunk whose JSON carries .usage — usually the last one)
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
                usage = {
                  tokensIn: j.usage.prompt_tokens,
                  tokensOut: j.usage.completion_tokens ?? 0,
                  source: 'provider',
                };
              }
            } catch {
              /* non-JSON data line — pass through untouched */
            }
          }
        }
        raw.end();
      } catch (e) {
        if (!raw.writableEnded) raw.end();
        await finish('error', usage);
        console.error('[flow] stream error', e);
        return;
      }
      await finish('ok', usage);
      return;
    }

    // non-streaming: buffer, report, relay
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) {
      await finish('error', { tokensIn: 0, tokensOut: 0, source: 'provider' });
      return reply.code(502).send({ error: 'upstream returned non-JSON' });
    }
    const u = json?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const usage: Usage =
      u && typeof u.prompt_tokens === 'number'
        ? { tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens ?? 0, source: 'provider' }
        : { tokensIn: 0, tokensOut: 0, source: 'provider-silent' };
    await finish('ok', usage);
    return { ...json, _jatin: { request_id: requestId, usage_source: usage.source } };
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
        credential: { select: { keyMask: true, provider: true, label: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { requests };
  });
}
