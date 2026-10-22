'use strict';
// Durable replay-safety ledger. Append-only JSON lines, fsync after every write.
//   {"t":"pending", ...}  written BEFORE any input is sent to Herdr
//   {"t":"done", ...}     written after the outcome is known
// A "pending" without a later "done" at boot means the portal stopped between
// "maybe sent" and "result recorded": it is finalized as needs_review with recovered_at (finished_at stays null: the
// outcome time is unknown).
// Rows written by this version carry kind ("pane" | "file"), intent_id and audit:"owed"; once the audit line for an
// outcome is written, {"t":"audited","intent_id"} acknowledges it. reconcile() at boot writes the audit line for every
// owed outcome without an ack, from the ledger row alone; nothing is re-sent or rewritten. A crash after the audit
// line but before its ack yields a second line with the same intent_id (at least once, never exactly once). A pending
// row from an older version is still finalized as needs_review and audited once, as before; older done rows are never
// reconciled into audit lines and never rewritten.
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

// Recovery looks at the file without following a symlink or reading its content.
function observe(file) {
  try { const st = fs.lstatSync(file); return { exists: true, regular_file: st.isFile(), bytes: st.size }; } catch { return { exists: false }; }
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
    const pending = new Map(); const owed = new Map(); this.acked = new Set();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const key = o.intent_id || o.idempotency_key;
      if (o.t === 'pending') {
        pending.set(key, o);
        if (o.kind !== 'file') this.byKey.set(o.idempotency_key, { hash: o.payload_hash, state: 'pending', record: o });
      } else if (o.t === 'done') {
        pending.delete(key);
        if (o.kind !== 'file') this.byKey.set(o.idempotency_key, { hash: o.payload_hash, state: 'done', record: o });
        if (o.audit === 'owed') owed.set(o.intent_id, o);
      } else if (o.t === 'audited') this.acked.add(o.intent_id);
    }
    this.recovered = [];
    for (const p of pending.values()) {
      const done = { ...p, t: 'done', intent_id: p.intent_id || crypto.randomUUID(), finished_at: null, recovered_at: new Date().toISOString(), status: 'needs_review', audit: 'owed',
        detail: p.kind === 'file'
          ? { reason: 'portal_restarted_before_result_recorded', note: 'The file may or may not have been written. Inspect it before any retry.', observed: observe(p.path) }
          : { reason: 'portal_restarted_before_result_recorded', note: 'Input may or may not have been sent. Inspect the pane before any retry.' } };
      this._append(done);
      if (p.kind !== 'file') this.byKey.set(p.idempotency_key, { hash: p.payload_hash, state: 'done', record: done });
      owed.set(done.intent_id, done);
      this.recovered.push(done);
    }
    this.owed = [...owed.values()].filter((r) => !this.acked.has(r.intent_id));
  }

  // Writes each owed audit line, then its ack. Stops at the first audit failure; the rest stay owed for the next boot.
  reconcile(write) {
    let n = 0;
    for (const row of this.owed) {
      try { write(row); } catch { break; }
      this.audited(row.intent_id); n += 1;
    }
    this.owed = this.owed.slice(n);
    return n;
  }

  audited(intent_id) { this._append({ t: 'audited', intent_id }); this.acked.add(intent_id); }

  lookup(key) { return this.byKey.get(key); }

  begin(rec) { // synchronous + fsynced: durable before execution starts
    const row = { t: 'pending', ...rec };
    this._append(row);
    if (rec.kind !== 'file') this.byKey.set(rec.idempotency_key, { hash: rec.payload_hash, state: 'pending', record: row });
  }

  finish(rec) {
    const row = { t: 'done', ...rec };
    this._append(row);
    if (rec.kind !== 'file') this.byKey.set(rec.idempotency_key, { hash: rec.payload_hash, state: 'done', record: row });
    return row;
  }

  recent(n = 50) {
    const rows = [];
    for (const v of this.byKey.values()) if (v.state === 'done') rows.push(v.record);
    rows.sort((a, b) => ((a.finished_at || a.recovered_at) < (b.finished_at || b.recovered_at) ? 1 : -1));
    return rows.slice(0, n);
  }
}

module.exports = { Ledger, payloadHash, canonical };
