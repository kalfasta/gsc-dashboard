/**
 * Cloudflare Worker — Proxy for Mailchimp + Ahrefs + SerpAPI + BigQuery
 * KV binding: RANKS_KV
 * Secret: BQ_SA_KEY  (full service account JSON string)
 * Cron: every 3 days at 9 AM Greece time
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-MC-Key, Authorization, X-Serp-Key',
};

const SERP_API_KEY = '5fa904686b12942d5ea35c4156ebf5c30084383f8d40fd44028bd90ac15ecd7f';
const TARGET_DOMAIN = 'pricefox.gr';
const BQ_PROJECT = 'pricefox-ads-pipeline';

// ── GOOGLE SERVICE ACCOUNT TOKEN (JWT → access_token) ────────────────────────
// Cache token in memory for duration of worker instance
let _tokenCache = null;

async function getGoogleToken(env) {
  if (_tokenCache && _tokenCache.exp > Date.now() + 60000) {
    return _tokenCache.token;
  }
  if (!env.BQ_SA_KEY) throw new Error('BQ_SA_KEY secret not set');

  const sa = JSON.parse(env.BQ_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  // Build JWT header + payload
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp,
  }));

  const signingInput = header + '.' + payload;

  // Import the RSA private key
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
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const jwt = signingInput + '.' + b64urlRaw(signature);

  // Exchange JWT for access token
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

// ── BIGQUERY QUERY HELPER ────────────────────────────────────────────────────
async function runBqQuery(sql, token) {
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
      const result = await fetchSerpRank(query);
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

async function fetchSerpRank(query) {
  for (let page = 0; page < 5; page++) {
    const start = page * 10;
    const params = new URLSearchParams({
      q: query, gl: 'gr', hl: 'el', google_domain: 'google.gr',
      api_key: SERP_API_KEY, num: '10', start: String(start), output: 'json',
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
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ── BIGQUERY PROXY (/bq) ─────────────────────────────────────────────
    if (path === '/bq' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.sql) return json({ error: 'sql required' }, 400);
        const token = await getGoogleToken(env);
        const rows = await runBqQuery(body.sql, token);
        return json({ rows });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── MAILCHIMP PROXY (/mc/*) ──────────────────────────────────────────
    if (path.startsWith('/mc')) {
      const mcKey = request.headers.get('X-MC-Key') || '';
      if (!mcKey) return new Response('Missing X-MC-Key header', { status: 400, headers: CORS_HEADERS });
      const dc = mcKey.split('-').pop();
      if (!dc || dc === mcKey) return new Response('Invalid Mailchimp API key format', { status: 400, headers: CORS_HEADERS });
      const mcPath = path.replace(/^\/mc/, '');
      const mcUrl = `https://${dc}.api.mailchimp.com/3.0${mcPath}${url.search}`;
      const mcResp = await fetch(mcUrl, {
        method: request.method,
        headers: { 'Authorization': 'Basic ' + btoa('anystring:' + mcKey), 'Content-Type': 'application/json' },
        body: request.method !== 'GET' ? request.body : undefined,
      });
      return new Response(await mcResp.text(), { status: mcResp.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── AHREFS PROXY (/ahrefs/*) ─────────────────────────────────────────
    if (path.startsWith('/ahrefs')) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) return new Response('Missing Authorization Bearer header', { status: 400, headers: CORS_HEADERS });
      const ahrefsUrl = `https://api.ahrefs.com${path.replace(/^\/ahrefs/, '')}${url.search}`;
      const ahrefsResp = await fetch(ahrefsUrl, {
        method: request.method,
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: request.method !== 'GET' ? request.body : undefined,
      });
      return new Response(await ahrefsResp.text(), { status: ahrefsResp.status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ── RANK TRACKER: GET /ranks ─────────────────────────────────────────
    if (path === '/ranks' && request.method === 'GET') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      const [histStored, lastFetch, queriesStored] = await Promise.all([
        env.RANKS_KV.get('ranks_history'),
        env.RANKS_KV.get('last_fetch'),
        env.RANKS_KV.get('core_queries'),
      ]);
      return json({ history: histStored ? JSON.parse(histStored) : {}, last_fetch: lastFetch || null, queries: queriesStored ? JSON.parse(queriesStored) : [] });
    }

    // ── RANK TRACKER: POST /ranks/queries ────────────────────────────────
    if (path === '/ranks/queries' && request.method === 'POST') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      const body = await request.json().catch(() => ({}));
      if (!Array.isArray(body.queries)) return json({ error: 'queries must be array' }, 400);
      await env.RANKS_KV.put('core_queries', JSON.stringify(body.queries));
      return json({ ok: true, saved: body.queries.length });
    }

    // ── RANK TRACKER: POST /ranks/trigger ────────────────────────────────
    if (path === '/ranks/trigger' && request.method === 'POST') {
      if (!env.RANKS_KV) return json({ error: 'KV not configured' }, 500);
      runRankCheck(env).catch(console.error);
      return json({ ok: true, message: 'Rank check triggered in background' });
    }

    // ── RANK TRACKER: POST /ranks/test ───────────────────────────────────
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
  return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}
