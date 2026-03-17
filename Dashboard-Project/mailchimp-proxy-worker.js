// Cloudflare Worker — Mailchimp CORS Proxy
// Deploy at: https://workers.cloudflare.com
// 1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
// 2. Paste this code → Deploy
// 3. Note the URL (e.g. https://mc-proxy.your-account.workers.dev)
// 4. Paste that URL into the dashboard's "Proxy URL" field

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-MC-Key, X-Ahrefs-Key',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── Mailchimp proxy (/mc/...) ──────────────────────────────────
    if (path.startsWith('/mc/')) {
      const apiKey = request.headers.get('X-MC-Key') || '';
      if (!apiKey) {
        return new Response(JSON.stringify({ error: 'Missing X-MC-Key header' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
      const dc = apiKey.split('-').pop() || 'us14';
      const targetPath = path.replace('/mc/', '/3.0/');
      const mcUrl = `https://${dc}.api.mailchimp.com${targetPath}${url.search}`;
      try {
        const resp = await fetch(mcUrl, {
          method: request.method,
          headers: {
            'Authorization': 'Basic ' + btoa('anystring:' + apiKey),
            'Content-Type': 'application/json'
          }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── Ahrefs proxy (/ahrefs/...) ─────────────────────────────────
    if (path.startsWith('/ahrefs/')) {
      const ahKey = request.headers.get('X-Ahrefs-Key') || '';
      if (!ahKey) {
        return new Response(JSON.stringify({ error: 'Missing X-Ahrefs-Key header' }), {
          status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
      const ahPath = path.replace('/ahrefs', '/v3');
      const ahUrl = `https://api.ahrefs.com${ahPath}${url.search}`;
      try {
        const resp = await fetch(ahUrl, {
          method: request.method,
          headers: {
            'Authorization': 'Bearer ' + ahKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Unknown route' }), {
      status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
    });
  }
};
