'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, PINNED_HERDR_VERSION } = require('./config');
const { checkBearer, RateLimiter, hostAllowed } = require('./security');
const { ApiError } = require('./validate');
const { ACTIONS, dispatch, methodOf, httpStatusFor } = require('./actions');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, 'Content-Length': buf.length, ...extra });
  res.end(buf);
}

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip']; // set by Cloudflare; only cloudflared can reach the loopback listener remotely
  return (typeof cf === 'string' && cf.length < 64 ? cf : req.socket.remoteAddress) || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) { reject(new ApiError(413, 'body_too_large', 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer({ ctx, tokenDigest, log, tunnelProbe }) {
  const authFail = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 8 });
  const reqLimit = new RateLimiter({ windowMs: 60 * 1000, max: 240 });
  const staticCache = new Map();

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    let status = 500; let ident = '-';
    try {
      if (!hostAllowed(req.headers.host)) throw new ApiError(421, 'bad_host', 'host not allowed');
      const url = new URL(req.url, 'http://x');
      const ip = clientIp(req);
      if (reqLimit.hit(ip) > reqLimit.max) throw new ApiError(429, 'rate_limited', 'too many requests');

      if (!url.pathname.startsWith('/api/')) { // public: login shell + static assets only, no Herdr data
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'GET only');
        if (url.pathname === '/healthz') { status = 200; return send(res, 200, { portal: 'up' }); }
        const f = STATIC[url.pathname];
        if (!f) throw new ApiError(404, 'not_found', 'not found');
        if (!staticCache.has(f[0])) staticCache.set(f[0], fs.readFileSync(path.join(PUBLIC_DIR, f[0])));
        status = 200; return send(res, 200, staticCache.get(f[0]), f[1]);
      }

      // ---- API: authenticate first, before parsing or routing anything ----
      if (authFail.blocked(ip)) throw new ApiError(429, 'rate_limited', 'too many failed attempts');
      if (!checkBearer(req.headers.authorization, tokenDigest)) {
        authFail.hit(ip);
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'unauthorized', 'unauthorized');
      }
      const origin = req.headers.origin;
      if (origin) {
        let oh = null; try { oh = new URL(origin).host; } catch { /* "null" and other opaque origins */ }
        if (oh !== req.headers.host) throw new ApiError(403, 'bad_origin', 'cross-origin request refused');
      }

      let body;
      if (url.pathname === '/api/health') {
        body = await health(ctx, tunnelProbe);
      } else if (url.pathname === '/api/inventory') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, ...ctx.inventory.view() };
      } else if (url.pathname === '/api/ledger') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, results: ctx.ledger.recent(50).map((r) => ({ request_id: r.request_id, idempotency_key: r.idempotency_key, action: r.action, status: r.status, target: r.target, started_at: r.started_at, finished_at: r.finished_at })) };
      } else if (url.pathname === '/api/herdr') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, actions: Object.entries(ACTIONS).map(([name, a]) => ({ action: name, http: methodOf(name), summary: a.summary, params: Object.keys(a.params), write: !!a.write })), writes_enabled: ctx.writesEnabled, writes_disabled_reason: ctx.writesDisabledReason || null };
      } else {
        const m = /^\/api\/herdr\/([a-z_]+)$/.exec(url.pathname);
        if (!m) throw new ApiError(404, 'not_found', 'not found');
        const name = 'herdr.' + m[1];
        let params;
        if (req.method === 'GET') {
          params = {};
          for (const [k, v] of url.searchParams) {
            if (k in params) throw new ApiError(400, 'duplicate_param', 'duplicate query parameter');
            params[k] = v;
          }
          const a = ACTIONS[name];
          if (a) coerceQuery(a.params, params);
        } else if (req.method === 'POST') {
          if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'unsupported_media_type', 'application/json required');
          const raw = await readBody(req);
          try { params = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'bad_json', 'invalid JSON'); }
        } else throw new ApiError(405, 'method_not_allowed', 'GET or POST only');
        ident = name;
        body = await dispatch(ctx, name, req.method, params);
      }
      status = httpStatusFor(body);
      return send(res, status, body);
    } catch (e) {
      if (e instanceof ApiError) { status = e.status; return send(res, e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } }); }
      log('internal_error', { message: String(e && e.message).slice(0, 200) });
      status = 500; return send(res, 500, { ok: false, error: { code: 'internal', message: 'internal error' } });
    } finally {
      // method + path + status only: never headers, query strings or bodies (no token, no terminal text)
      log('http', { m: req.method, p: String(req.url).split('?')[0].slice(0, 80), s: status, ms: Date.now() - t0, a: ident });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxHeaderSize = 8192;
  return server;
}

// GET query values arrive as strings; convert only where the schema expects numbers/lists.
function coerceQuery(spec, params) {
  for (const [k, v] of Object.entries(params)) {
    const s = spec[k];
    if (!s) continue;
    if (s.check(v)) continue;
    if (/^\d+$/.test(v) && s.check(Number(v))) params[k] = Number(v);
    else if (v.includes(',') || /^[a-z]+$/.test(v)) { const list = v.split(','); if (s.check(list)) params[k] = list; }
  }
}

async function health(ctx, tunnelProbe) {
  const inv = ctx.inventory.view();
  const tunnel = await tunnelProbe();
  const worst = inv.sessions.reduce((m, s) => Math.max(m, s.snapshot_age_ms ?? Infinity), 0);
  return {
    ok: true, generated_at: new Date().toISOString(),
    portal: { up: true, version: config.version, uptime_s: Math.round(process.uptime()) },
    tunnel,
    herdr: { reachable_sessions: inv.totals.accessible, total_sessions: inv.totals.sessions, installed_version: ctx.herdrVersion, writes_enabled: ctx.writesEnabled, writes_disabled_reason: ctx.writesDisabledReason || null,
      contract: ctx.compat ? { protocol: ctx.compat.protocol, verified_version: PINNED_HERDR_VERSION, verified_live: ctx.compat.version === PINNED_HERDR_VERSION, strict: !!ctx.strict, failing_actions: Object.entries(ctx.compat.actions).filter(([, c]) => !c.ok).map(([action, c]) => ({ action, reason: c.reason })) } : null },
    data: { stale: inv.sessions.some((s) => s.stale) || inv.sessions.length === 0, worst_age_ms: Number.isFinite(worst) ? worst : null },
  };
}

module.exports = { createServer };
