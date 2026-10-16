'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { config, PINNED_HERDR_VERSION } = require('./config');
const { checkBearer, RateLimiter, hostAllowed } = require('./security');
const { ApiError } = require('./validate');
const { ACTIONS, dispatch, recordRefusal, methodOf, httpStatusFor } = require('./actions');
const buildIdentity = require('./build-identity');

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

// Reads at most `limit` bytes. Past the limit the rest is read and thrown away, never `req.destroy()`ed: destroying the
// socket before the 413 is written resets the connection, and the proxy in front (cloudflared) then reports a 502
// ("Unable to reach the origin service ... use of closed network connection") instead of this answer. The 413 is sent while
// the upload is still being drained, and the connection stays usable afterwards; server.requestTimeout (20 s) bounds the draining.
// Docs: message.destroy() "Calls destroy() on the socket that received the IncomingMessage" (https://nodejs.org/docs/latest-v22.x/api/http.html#messagedestroyerror);
// cloudflared 502 "Unable to reach the origin service. The service may be down or it may not be responding to traffic from cloudflared"
// (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/troubleshoot-tunnels/common-errors/).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; let over = false; const chunks = [];
    const tooBig = () => { over = true; chunks.length = 0; reject(new ApiError(413, 'body_too_large', `request body too large (limit ${limit} bytes)`)); };
    if (Number(req.headers['content-length']) > limit) tooBig();
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) return tooBig();
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// RFC 8259 section 8.1: "JSON text exchanged between systems that are not part of a closed ecosystem MUST be encoded using UTF-8."
// TextDecoder `fatal`: "true if decoding failures are fatal" (https://nodejs.org/docs/latest-v22.x/api/util.html#class-utiltextdecoder).
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function createServer({ ctx, tokenDigest, log, tunnelProbe }) {
  const authFail = new RateLimiter({ windowMs: 5 * 60 * 1000, max: 8 });
  const reqLimit = new RateLimiter({ windowMs: 60 * 1000, max: 240 });
  // Loaded once at start, so the bytes served and the checksum in /api/health are the same bytes for the whole run.
  const staticCache = new Map([...new Set(Object.values(STATIC).map((f) => f[0]))].map((f) => [f, fs.readFileSync(path.join(PUBLIC_DIR, f))]));
  const build = { code_sha256: buildIdentity.codeDigest(), static_sha256: buildIdentity.staticDigest(staticCache), ...buildIdentity.instance };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    let status = 500; let ident = '-'; let flat = false; let authed = false; let dispatched = false;
    try {
      flat = String(req.url).split('?')[0] === '/api/herdr/put_file'; // this action's errors are {ok:false, error:"<code>", detail:"..."}, from the first check on
      if (!hostAllowed(req.headers.host)) throw new ApiError(421, 'bad_host', 'host not allowed');
      const url = new URL(req.url, 'http://x');
      const ip = clientIp(req);
      if (reqLimit.hit(ip) > reqLimit.max) throw new ApiError(429, 'rate_limited', 'too many requests');

      if (!url.pathname.startsWith('/api/')) { // public: login shell + static assets only, no Herdr data
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'method_not_allowed', 'GET only');
        if (url.pathname === '/healthz') { status = 200; return send(res, 200, { portal: 'up' }); }
        const f = STATIC[url.pathname];
        if (!f) throw new ApiError(404, 'not_found', 'not found');
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

      authed = true;
      let body;
      if (url.pathname === '/api/health') {
        body = await health(ctx, tunnelProbe, build);
      } else if (url.pathname === '/api/inventory') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, ...ctx.inventory.view() };
      } else if (url.pathname === '/api/ledger') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, results: ctx.ledger.recent(50).map((r) => ({ request_id: r.request_id, idempotency_key: r.idempotency_key, action: r.action, status: r.status, target: r.target, started_at: r.started_at, finished_at: r.finished_at, recovered_at: r.recovered_at || null })) };
      } else if (url.pathname === '/api/herdr') {
        if (req.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only');
        body = { ok: true, actions: Object.entries(ACTIONS).map(([name, a]) => ({ action: name, http: methodOf(name), summary: a.summary, params: Object.keys(a.params), write: !!(a.write || a.drop) })), writes_enabled: ctx.writesEnabled, writes_disabled_reason: ctx.writesDisabledReason || null };
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
          const buf = await readBody(req, name === 'herdr.put_file' ? config.maxPutFileBodyBytes : config.maxBodyBytes);
          let raw;
          if (name === 'herdr.put_file') { try { raw = STRICT_UTF8.decode(buf); } catch { throw new ApiError(400, 'content_not_utf8', 'request body is not valid UTF-8'); } } // JSON text must be UTF-8 (RFC 8259 section 8.1); no replacement characters
          else raw = buf.toString('utf8');
          if (name === 'herdr.put_file' && !/^\s*\{/.test(raw.slice(0, 64))) throw new ApiError(400, 'bad_json', 'request body must be a JSON object'); // refuses deeply nested arrays before JSON.parse spends time on them
          try { params = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'bad_json', 'invalid JSON'); }
        } else throw new ApiError(405, 'method_not_allowed', 'GET or POST only');
        ident = name;
        dispatched = true;
        body = await dispatch(ctx, name, req.method, params);
      }
      status = httpStatusFor(body);
      return send(res, status, body);
    } catch (e) {
      if (flat && authed && !dispatched && e instanceof ApiError) recordRefusal(ctx, 'herdr.put_file', e);
      if (e instanceof ApiError) {
        status = e.status;
        // put_file adds only named fields: the committed_unverified facts, and after a recorded intent its id and a deferred audit.
        return send(res, e.status, flat ? { ok: false, error: e.code, detail: e.message, ...(e.code === 'committed_unverified' ? e.extra : {}), ...(e.intent_id ? { intent_id: e.intent_id } : {}), ...(e.extra && e.extra.audit === 'deferred' ? { audit: 'deferred' } : {}) } : { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
      }
      log('internal_error', { message: String(e && e.message).slice(0, 200) });
      status = 500; return send(res, 500, flat ? { ok: false, error: 'internal', detail: 'internal error' } : { ok: false, error: { code: 'internal', message: 'internal error' } });
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

async function health(ctx, tunnelProbe, build) {
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
    build: { ...build, flags: { strict_version: !!ctx.strict, agent_decision: process.env.HERDR_PORTAL_ENABLE_AGENT_DECISION === '1' } },
  };
}

module.exports = { createServer };
