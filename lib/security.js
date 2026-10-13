'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { config } = require('./config');

const sha = (s) => crypto.createHash('sha256').update(s).digest();

function loadTokenDigest() {
  const st = fs.statSync(config.tokenFile);
  if ((st.mode & 0o077) !== 0) throw new Error('token file must be mode 0600');
  const tok = fs.readFileSync(config.tokenFile, 'utf8').trim();
  if (tok.length < 43) throw new Error('token too short (need >= 32 random bytes, base64url)');
  return sha(tok);
}

function createToken() {
  fs.mkdirSync(require('path').dirname(config.tokenFile), { recursive: true, mode: 0o700 });
  const tok = crypto.randomBytes(32).toString('base64url'); // 32 bytes of CSPRNG output
  const tmp = config.tokenFile + '.tmp';
  fs.writeFileSync(tmp, tok + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, config.tokenFile);
  return tok.length;
}

// Both sides are hashed first so timingSafeEqual always gets equal-length buffers.
function checkBearer(header, digest) {
  if (typeof header !== 'string') return false;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  if (!m) return false;
  return crypto.timingSafeEqual(sha(m[1]), digest);
}

class RateLimiter {
  constructor({ windowMs, max }) { this.windowMs = windowMs; this.max = max; this.hits = new Map(); }
  _prune(arr, now) { while (arr.length && now - arr[0] > this.windowMs) arr.shift(); }
  count(key, now = Date.now()) {
    const arr = this.hits.get(key) || [];
    this._prune(arr, now);
    return arr.length;
  }
  hit(key, now = Date.now()) {
    const arr = this.hits.get(key) || [];
    this._prune(arr, now);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) { this._prune(v, now); if (!v.length) this.hits.delete(k); }
    return arr.length;
  }
  blocked(key, now = Date.now()) { return this.count(key, now) >= this.max; }
}

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  const h = hostHeader.toLowerCase().replace(/:\d+$/, '');
  if (h === '127.0.0.1' || h === 'localhost') return true;
  if (config.extraAllowedHosts.includes(h)) return true;
  return config.allowedHostSuffixes.some((s) => h.endsWith(s) && h.length > s.length);
}

module.exports = { loadTokenDigest, createToken, checkBearer, RateLimiter, hostAllowed };
