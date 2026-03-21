/**
 * Cloudflare Worker — Proxy for Mailchimp + Ahrefs + SerpAPI + BigQuery
 * KV binding: RANKS_KV
 * Secrets: BQ_SA_KEY, SERP_API_KEY, AHREFS_API_KEY, MC_API_KEY, WORKER_AUTH_TOKEN
 * Cron: every 3 days at 9 AM Greece time
 */

// Allowed origins — restrict CORS
const ALLOWED_ORIGINS = [
  'https://kalfasta.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':') || origin.startsWith(o + '/'));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

const TARGET_DOMAIN = 'pricefox.gr';
const BQ_PROJECT = 'pricefox-ads-pipeline';

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────────
function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token !== env.WORKER_AUTH_TOKEN) {
    return false;
  }
  return true;
}

// ── GOOGLE SERVICE ACCOUNT TOKEN (JWT → access_token) ────────────────────────
let _tokenCache = null;

async function getGoogleToken(env) {
  if (_tokenCache && _tokenCache.exp > Date.now() + 60000) {
    return _tokenCache.token;
  }
  if (!env.BQ_SA_KEY) throw new Error('BQ_SA_KEY secret not set');

  const sa = JSON.parse(env.BQ_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp,
  }));

  const signingInput = header + '.' + payload;
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = signingInput + '.' + b64urlRaw(signature);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });
  if (!tokenResp.ok) {
    const t = await tokenResp.text();
    throw new Error('Token exchange failed: ' + t);
  }
  const tokenData = await tokenResp.json();
  _tokenCache = { token: tokenData.access_token, exp: Date.now() + 3500 * 1000 };
  return _tokenCache.token;
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64urlRaw(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── BIGQUERY QUERY (whitelist-safe) ──────────────────────────────────────────
// Only allow SELECT queries on pricefox-ads-pipeline datasets
function validateSql(sql) {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    throw new Error('Only SELECT/WITH queries allowed');
  }
  // Block dangerous keywords
  const blocked = ['DROP', 'DELETE', 'INSERT', 'UPDATE', 'CREATE', 'ALTER', 'TRUNCATE', 'MERGE', 'GRANT', 'REVOKE'];
  for (const kw of blocked) {
    // Match whole word only
    if (new RegExp('\\b' + kw + '\\b', 'i').test(sql)) {
      throw new Error(`${kw} statements not allowed`);
    }
  }
  return true;
}

async function runBqQuery(sql, token) {
  validateSql(sql);
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT}/queries`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, location: 'EU', timeoutMs: 30000 }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'BigQuery error ' + resp.status);
  }
  const data = await resp.json();
  if (!data.jobComplete) throw new Error('BigQuery job timed out — try again');
  if (!data.rows) return [];
  const fields = data.schema.fields.map(f => f.name);
  return data.rows.map(row => {
    const obj = {};
    row.f.forEach((cell, i) => { obj[fields[i]] = cell.v; });
    return obj;
  });
}

// ── CRON HANDLER ─────────────────────────────────────────────────────────────
async function runRankCheck(env) {
  if (!env.RANKS_KV) { console.error('RANKS_KV binding missing'); return; }

  const stored = await env.RANKS_KV.get('core_queries');
  if (!stored) { console.log('No core_queries in KV, nothing to fetch'); return; }
  const queries = JSON.parse(stored);
  console.log(`Rank check started: ${queries.length} queries`);

  const histStored = await env.RANKS_KV.get('ranks_history');
  const history = histStored ? JSON.parse(histStored) : {};
  const today = new Date().toISOString().slice(0, 10);

  for (const query of queries) {
    try {
      const result = await fetchSerpRank(query, env);
      if (!history[query]) history[query] = [];
      history[query] = history[query].filter(r => r.date !== today);
      history[query].push({ date: today, ...result });
      if (history[query].length > 90) history[query] = history[query].slice(-90);
      await new Promise(r => setTimeout(r, 1100));
    } catch (e) {
      console.error(`Error fetching rank for "${query}":`, e.message);
    }
  }

  await env.RANKS_KV.put('ranks_history', JSON.stringify(history));
  await env.RANKS_KV.put('last_fetch', new Date().toISOString());
  console.log(`Rank check complete: ${queries.length} queries processed`);
}

async function fetchSerpRank(query, env) {
  const apiKey = env.SERP_API_KEY;
  if (!apiKey) throw new Error('SERP_API_KEY secret not set');

  for (let page = 0; page < 5; page++) {
    const start = page * 10;
    const params = new URLSearchParams({
      q: query, gl: 'gr', hl: 'el', google_domain: 'google.gr',
      api_key: apiKey, num: '10', start: String(start), output: 'json',
    });
    const resp = await fetch('https://serpapi.com/search?' + params.toString());
    if (!resp.ok) throw new Error('SerpAPI ' + resp.status);
    const data = await resp.json();

    const organic = data.organic_results || [];
    const hit = organic.find(r =>
      (r.link && r.link.includes(TARGET_DOMAIN)) ||
      (r.displayed_link && r.displayed_link.includes(TARGET_DOMAIN))
    );
    if (hit) {
      return { rank: start + hit.position, url: hit.link || '', title: hit.title || '', snippet: (hit.snippet || '').slice(0, 120) };
    }
    if (!data.serpapi_pagination?.next) break;
    await new Promise(r => setTimeout(r, 600));
  }
  return { rank: null, url: '', title: '', snippet: '' };
}

// ── FETCH HANDLER ─────────────────────────────────────────────────────────────
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRankCheck(env));
  },

  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Helper to return JSON
    const jsonResp = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // ── BIGQUERY PROXY (/bq) — requires auth ─────────────────────────────
    if (path === '/bq' && request.method === 'POST') {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.sql) return jsonResp({ error: 'sql required' }, 400);
        const token = await getGoogleToken(env);
        const rows = await runBqQuery(body.sql, token);
        return jsonResp({ rows });
      } catch (e) {
        return jsonResp({ error: e.message }, 500);
      }
    }

    // ── MAILCHIMP PROXY (/mc/*) — uses server-side key ────────────────────
    if (path.startsWith('/mc')) {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      const mcKey = env.MC_API_KEY;
      if (!mcKey) return jsonResp({ error: 'MC_API_KEY not configured' }, 500);
      const dc = mcKey.split('-').pop();
      const mcPath = path.replace(/^\/mc/, '');
      const mcUrl = `https://${dc}.api.mailchimp.com/3.0${mcPath}${url.search}`;
      const mcResp = await fetch(mcUrl, {
        method: request.method,
        headers: { 'Authorization': 'Basic ' + btoa('anystring:' + mcKey), 'Content-Type': 'application/json' },
        body: request.method !== 'GET' ? request.body : undefined,
      });
      return new Response(await mcResp.text(), { status: mcResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── AHREFS PROXY (/ahrefs/*) — uses server-side key ────────────────────
    if (path.startsWith('/ahrefs')) {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      const ahrefsKey = env.AHREFS_API_KEY;
      if (!ahrefsKey) return jsonResp({ error: 'AHREFS_API_KEY not configured' }, 500);
      const ahrefsUrl = `https://api.ahrefs.com${path.replace(/^\/ahrefs/, '')}${url.search}`;
      const ahrefsResp = await fetch(ahrefsUrl, {
        method: request.method,
        headers: { 'Authorization': 'Bearer ' + ahrefsKey, 'Content-Type': 'application/json' },
        body: request.method !== 'GET' ? request.body : undefined,
      });
      return new Response(await ahrefsResp.text(), { status: ahrefsResp.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── RANK TRACKER: GET /ranks — public read (no sensitive data) ─────────
    if (path === '/ranks' && request.method === 'GET') {
      if (!env.RANKS_KV) return jsonResp({ error: 'KV not configured' }, 500);
      const [histStored, lastFetch, queriesStored] = await Promise.all([
        env.RANKS_KV.get('ranks_history'),
        env.RANKS_KV.get('last_fetch'),
        env.RANKS_KV.get('core_queries'),
      ]);
      return jsonResp({ history: histStored ? JSON.parse(histStored) : {}, last_fetch: lastFetch || null, queries: queriesStored ? JSON.parse(queriesStored) : [] });
    }

    // ── RANK TRACKER: POST /ranks/queries — requires auth ─────────────────
    if (path === '/ranks/queries' && request.method === 'POST') {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      if (!env.RANKS_KV) return jsonResp({ error: 'KV not configured' }, 500);
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.queries)) return jsonResp({ error: 'queries must be array' }, 400);
      await env.RANKS_KV.put('core_queries', JSON.stringify(body.queries));
      return jsonResp({ ok: true, saved: body.queries.length });
    }

    // ── RANK TRACKER: POST /ranks/trigger — requires auth ─────────────────
    if (path === '/ranks/trigger' && request.method === 'POST') {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      if (!env.RANKS_KV) return jsonResp({ error: 'KV not configured' }, 500);
      runRankCheck(env).catch(console.error);
      return jsonResp({ ok: true, message: 'Rank check triggered in background' });
    }

    // ── RANK TRACKER: POST /ranks/test — requires auth ────────────────────
    if (path === '/ranks/test' && request.method === 'POST') {
      if (!requireAuth(request, env)) return jsonResp({ error: 'Unauthorized' }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.query) return jsonResp({ error: 'query required' }, 400);
      try {
        const result = await fetchSerpRank(body.query, env);
        return jsonResp({ query: body.query, ...result });
      } catch (e) {
        return jsonResp({ error: e.message }, 500);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
