'use strict';
// Durable replay-safety ledger. Append-only JSON lines, fsync after every write.
//   {"t":"pending", ...}  written BEFORE any input is sent to Herdr
//   {"t":"done", ...}     written after the outcome is known
// A "pending" without a later "done" at boot means the portal stopped between
// "maybe sent" and "result recorded": it is finalized as needs_review.
const fs = require('fs');
const crypto = require('crypto');

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function payloadHash(action, params) {
  return crypto.createHash('sha256').update(canonical({ action, params })).digest('hex');
}

class Ledger {
  constructor(file) {
    this.file = file;
    this.byKey = new Map(); // idempotency_key -> { hash, state, record }
    this.inflight = new Map(); // idempotency_key -> Promise<record>
    this.fd = fs.openSync(file, 'a', 0o600);
    const size = fs.fstatSync(this.fd).size;
    if (size > 0) { // a torn last line must not swallow the next record
      const rfd = fs.openSync(file, 'r'); const tail = Buffer.alloc(1);
      try { fs.readSync(rfd, tail, 0, 1, size - 1); } finally { fs.closeSync(rfd); }
      if (tail[0] !== 0x0a) fs.writeSync(this.fd, '\n');
    }
    fs.chmodSync(file, 0o600);
    this._load();
  }

  _append(obj) {
    fs.writeSync(this.fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(this.fd);
  }

  _load() {
    const raw = fs.readFileSync(this.file, 'utf8');
    const pending = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.t === 'pending') {
        pending.set(o.idempotency_key, o);
        this.byKey.set(o.idempotency_key, { hash: o.payload_hash, state: 'pending', record: o });
      } else if (o.t === 'done') {
        pending.delete(o.idempotency_key);
        this.byKey.set(o.idempotency_key, { hash: o.payload_hash, state: 'done', record: o });
      }
    }
    this.recovered = [];
    for (const p of pending.values()) {
      const done = {
        t: 'done',
        request_id: p.request_id,
        idempotency_key: p.idempotency_key,
        payload_hash: p.payload_hash,
        action: p.action,
        session: p.session,
        target: p.target,
        started_at: p.started_at,
        finished_at: new Date().toISOString(),
        status: 'needs_review',
        detail: { reason: 'portal_restarted_before_result_recorded', note: 'Input may or may not have been sent. Inspect the pane before any retry.' },
      };
      this._append(done);
      this.byKey.set(p.idempotency_key, { hash: p.payload_hash, state: 'done', record: done });
      this.recovered.push(done);
    }
  }

  lookup(key) { return this.byKey.get(key); }

  begin(rec) { // synchronous + fsynced: durable before execution starts
    const row = { t: 'pending', ...rec };
    this._append(row);
    this.byKey.set(rec.idempotency_key, { hash: rec.payload_hash, state: 'pending', record: row });
  }

  finish(rec) {
    const row = { t: 'done', ...rec };
    this._append(row);
    this.byKey.set(rec.idempotency_key, { hash: rec.payload_hash, state: 'done', record: row });
    return row;
  }

  recent(n = 50) {
    const rows = [];
    for (const v of this.byKey.values()) if (v.state === 'done') rows.push(v.record);
    rows.sort((a, b) => (a.finished_at < b.finished_at ? 1 : -1));
    return rows.slice(0, n);
  }
}

module.exports = { Ledger, payloadHash, canonical };
