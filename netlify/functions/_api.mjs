// Netlify function = the entire Jatin API.
//
// A catch-all that bridges every /api/* request into the pre-built Fastify
// app (apps/api/dist, copied into this directory by the build command as
// _appdist). The bridge is a REAL local HTTP socket — not fastify.inject —
// because inject buffers the whole response, and the Flow surface is
// SSE: tokens must reach the client as the provider emits them.
//
// Boot is lazy per function instance (the warm instance reuses it), so a
// cold start pays buildApp() + Prisma connect once, then every invocation
// is a localhost round-trip.

let boot = null;

function getRuntime() {
  if (!boot) {
    boot = (async () => {
      const { buildApp } = await import('./_appdist/app.js');
      const app = await buildApp();
      await app.ready();
      await new Promise((resolve, reject) => {
        const srv = app.server;
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve());
      });
      return { base: `http://127.0.0.1:${app.server.address().port}` };
    })().catch((e) => {
      boot = null; // a failed boot must not poison the instance
      throw e;
    });
  }
  return boot;
}

export const handler = async (req) => {
  let base;
  try {
    ({ base } = await getRuntime());
  } catch (e) {
    return { statusCode: 503, body: 'api boot failed: ' + String(e) };
  }

  const url = base + (req.originalUrl || req.path || '/');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : req.body;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (e) {
    return { statusCode: 502, body: 'api unreachable: ' + String(e) };
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => outHeaders.set(k, v));
  // Returning the upstream stream (not a read-to-end text) is what makes
  // SSE flow chunk-by-chunk. 204/304 carry no body — Response(null) handles it.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
};
