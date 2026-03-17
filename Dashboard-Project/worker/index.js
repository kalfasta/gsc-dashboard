/**
 * Cloudflare Worker — Proxy for Mailchimp + Ahrefs + SerpAPI
 * KV binding: RANKS_KV (create in Cloudflare dashboard → Workers & Pages → KV)
 * Cron: every 3 days at 9 AM Greece time (7 AM UTC winter / 6 AM UTC summer)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-MC-Key, Authorization, X-Serp-Key',
};

const SERP_API_KEY = '5fa904686b12942d5ea35c4156ebf5c30084383f8d40fd44028bd90ac15ecd7f';
const TARGET_DOMAIN = 'pricefox.gr';

// ── CRON HANDLER ─────────────────────────────────────────────────────────────
async function runRankCheck(env) {
  if (!env.RANKS_KV) { console.error('RANKS_KV binding missing'); return; }

  // Load stored queries
  const stored = await env.RANKS_KV.get('core_queries');
  if (!stored) { console.log('No core_queries in KV, nothing to fetch'); return; }
  const queries = JSON.parse(stored);
  console.log(`Rank check started: ${queries.length} queries`);

  // Load existing history
  const histStored = await env.RANKS_KV.get('ranks_history');
  const history = histStored ? JSON.parse(histStored) : {};

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const query of queries) {
    try {
      const result = await fetchSerpRank(query);
      if (!history[query]) history[query] = [];
      // Remove any existing entry for today before adding new one
      history[query] = history[query].filter(r => r.date !== today);
      history[query].push({ date: today, ...result });
      // Keep max 90 days of history per query
      if (history[query].length > 90) history[query] = history[query].slice(-90);
      // Small delay to avoid rate limiting (SerpAPI free = 1 req/s)
      await new Promise(r => setTimeout(r, 1100));
    } catch (e) {
      console.error(`Error fetching rank for "${query}":`, e.message);
    }
  }

  await env.RANKS_KV.put('ranks_history', JSON.stringify(history));
  await env.RANKS_KV.put('last_fetch', new Date().toISOString());
  console.log(`Rank check complete: ${queries.length} queries processed`);
}

async function fetchSerpRank(query) {
  // Google returns 10 results per page — paginate up to 5 pages (top 50)
  for (let page = 0; page < 5; page++) {
    const start = page * 10;
    const params = new URLSearchParams({
      q: query,
      gl: 'gr',
      hl: 'el',
      google_domain: 'google.gr',
      api_key: SERP_API_KEY,
      num: '10',
      start: String(start),
      output: 'json',
    });
    const resp = await fetch('https://serpapi.com/search?' + params.toString());
    if (!resp.ok) throw new Error('SerpAPI ' + resp.status);
    const json = await resp.json();

    const organic = json.organic_results || [];
    // Find pricefox.gr — match on link or displayed_link
    const hit = organic.find(r =>
      (r.link && r.link.includes(TARGET_DOMAIN)) ||
      (r.displayed_link && r.displayed_link.includes(TARGET_DOMAIN))
    );

    if (hit) {
      // position resets to 1-10 per page, so add the page offset for real rank
      const realRank = start + hit.position;
      return {
        rank: realRank,
        url: hit.link || '',
        title: hit.title || '',
        snippet: (hit.snippet || '').slice(0, 120),
      };
    }

    // If no more pages, stop early
    if (!json.serpapi_pagination?.next) break;

    // Small delay between pages to respect rate limits
    await new Promise(r => setTimeout(r, 600));
  }

  return { rank: null, url: '', title: '', snippet: '' };
}

// ── FETCH HANDLER ─────────────────────────────────────────────────────────────
export default {
  // Scheduled cron trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRankCheck(env));
  },

  async fetch(request, env) {
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
      const ahrefsPath = path.replace(/^\/ahrefs/, '');
      const ahrefsUrl = `https://api.ahrefs.com${ahrefsPath}${url.search}`;
      const ahrefsResp = await fetch(ahrefsUrl, {
        method: request.method,
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: request.method !== 'GET' ? request.body : undefined,
      });
      const body = await ahrefsResp.text();
      return new Response(body, {
        status: ahrefsResp.status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // ── RANK TRACKER: GET /ranks ─────────────────────────────────────────
    // Returns { history, last_fetch, queries }
    if (path === '/ranks' && request.method === 'GET') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      const [histStored, lastFetch, queriesStored] = await Promise.all([
        env.RANKS_KV.get('ranks_history'),
        env.RANKS_KV.get('last_fetch'),
        env.RANKS_KV.get('core_queries'),
      ]);
      return json({
        history: histStored ? JSON.parse(histStored) : {},
        last_fetch: lastFetch || null,
        queries: queriesStored ? JSON.parse(queriesStored) : [],
      });
    }

    // ── RANK TRACKER: POST /ranks/queries ────────────────────────────────
    // Body: { queries: ["kw1", "kw2", ...] }  — saves core queries to KV
    if (path === '/ranks/queries' && request.method === 'POST') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.queries)) return json({ error: 'queries must be array' }, 400);
      await env.RANKS_KV.put('core_queries', JSON.stringify(body.queries));
      return json({ ok: true, saved: body.queries.length });
    }

    // ── RANK TRACKER: POST /ranks/trigger ────────────────────────────────
    // Manually trigger a full rank check (for testing)
    if (path === '/ranks/trigger' && request.method === 'POST') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      // Run in background so request doesn't timeout
      const ctx_like = { waitUntil: (p) => p };
      runRankCheck(env).catch(console.error);
      return json({ ok: true, message: 'Rank check triggered in background' });
    }

    // ── RANK TRACKER: POST /ranks/test ───────────────────────────────────
    // Test a single query immediately, returns result without saving
    if (path === '/ranks/test' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!body.query) return json({ error: 'query required' }, 400);
      try {
        const result = await fetchSerpRank(body.query);
        return json({ query: body.query, ...result });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
