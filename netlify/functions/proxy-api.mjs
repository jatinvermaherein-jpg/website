// Netlify function — proxy /api/* to the Jatin API.
//
// Why a function instead of a redirect: netlify.toml [[redirects]] cannot
// read environment variables (audit M4). The previous config pointed at a
// literal placeholder host; if nobody edited it, every /api/* call died in
// DNS while the site looked deployed. A function reads API_ORIGIN from the
// Netlify dashboard — the one knob, no file edits.
//
// Set in the Netlify dashboard: API_ORIGIN=https://<your>.up.railway.app

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

export const handler = async (req) => {
  const origin = process.env.API_ORIGIN;
  if (!origin) {
    return { statusCode: 502, body: 'API_ORIGIN is not set in the Netlify dashboard' };
  }

  const path = req.path.replace(/^\/proxy-api/, '') || '/';
  const search = req.query ? `?${new URLSearchParams(req.query).toString()}` : '';
  const target = new URL(path + search, origin);

  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())),
  );

  let res;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
    });
  } catch {
    return { statusCode: 502, body: 'cannot reach the API at ' + origin };
  }

  const body = await res.text();
  const resHeaders = Object.fromEntries(
    Object.entries(res.headers).filter(([k]) => !HOP_BY_HOP.has(k.toLowerCase())),
  );
  return { statusCode: res.status, headers: resHeaders, body };
};
