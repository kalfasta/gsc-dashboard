/**
 * Cloudflare Worker — Proxy for Mailchimp + Ahrefs APIs
 * Deploy: wrangler deploy (or paste into Cloudflare dashboard editor)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-MC-Key, Authorization',
};

export default {
  async fetch(request, env) {
    // Handle preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── MAILCHIMP PROXY (/mc/*) ──────────────────────────────────────────
    if (path.startsWith('/mc')) {
      const mcKey = request.headers.get('X-MC-Key') || '';
      if (!mcKey) {
        return new Response('Missing X-MC-Key header', { status: 400, headers: CORS_HEADERS });
      }

      // Extract datacenter from key (format: xxxxx-us21 → us21)
      const dc = mcKey.split('-').pop();
      if (!dc || dc === mcKey) {
        return new Response('Invalid Mailchimp API key format', { status: 400, headers: CORS_HEADERS });
      }

      const mcPath = path.replace(/^\/mc/, '');
      const mcUrl = `https://${dc}.api.mailchimp.com/3.0${mcPath}${url.search}`;

      const mcResp = await fetch(mcUrl, {
        method: request.method,
        headers: {
          'Authorization': 'Basic ' + btoa('anystring:' + mcKey),
          'Content-Type': 'application/json',
        },
        body: request.method !== 'GET' ? request.body : undefined,
      });

      const body = await mcResp.text();
      return new Response(body, {
        status: mcResp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // ── AHREFS PROXY (/ahrefs/*) ─────────────────────────────────────────
    if (path.startsWith('/ahrefs')) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response('Missing Authorization Bearer header', { status: 400, headers: CORS_HEADERS });
      }

      // Strip /ahrefs prefix and forward the rest to Ahrefs API
      const ahrefsPath = path.replace(/^\/ahrefs/, '');
      const ahrefsUrl = `https://api.ahrefs.com${ahrefsPath}${url.search}`;

      const ahrefsResp = await fetch(ahrefsUrl, {
        method: request.method,
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json',
        },
        body: request.method !== 'GET' ? request.body : undefined,
      });

      const body = await ahrefsResp.text();
      return new Response(body, {
        status: ahrefsResp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};
