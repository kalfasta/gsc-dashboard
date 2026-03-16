// Cloudflare Worker — Mailchimp CORS Proxy
// Deploy at: https://workers.cloudflare.com
// 1. Go to dash.cloudflare.com → Workers & Pages → Create Worker
// 2. Paste this code → Deploy
// 3. Note the URL (e.g. https://mc-proxy.your-account.workers.dev)
// 4. Paste that URL into the dashboard's "Proxy URL" field

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-MC-Key',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);
    const targetPath = url.pathname.replace('/mc/', '/3.0/');
    const apiKey = request.headers.get('X-MC-Key') || '';

    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Missing X-MC-Key header' }), {
        status: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }

    const dc = apiKey.split('-').pop() || 'us14';
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
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
      });
    }
  }
};
