'use strict';
// Reads the portal's audit log and turns its entries into screen rows. No dependency outside Node.
const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 64 * 1024;
const MAX_POLL = 1024 * 1024;

const auditPath = (env, home) => path.join(env.HERDR_PORTAL_LOG_DIR || path.join(home, 'Library', 'Logs', 'herdr-portal'), 'audit.jsonl');

function parseLine(line) {
  const t = String(line).trim();
  if (!t) return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  return o && typeof o === 'object' && !Array.isArray(o) && typeof o.action === 'string' ? o : null;
}

const verb = (action) => (typeof action === 'string' ? action.replace(/^herdr\./, '').replace(/^(agent|pane)_/, '').replace(/_/g, ' ') : 'unknown');

const isRead = (e) => e.result === 'read' || /(^|\.)(agent|pane)_read$/.test(String(e.action));

function tone(e) {
  if (isRead(e)) return 'read';
  switch (e.result) {
    case 'input_sent': case 'written': return 'ok';
    case 'input_sent_queued': return 'queued';
    case 'rejected': case 'failed': return 'refused';
    case 'needs_review': case 'committed_unverified': return 'review';
    default: return 'other';
  }
}

const OUTCOME = { input_sent: 'sent', input_sent_queued: 'queued', rejected: 'refused', failed: 'failed', needs_review: 'needs review', committed_unverified: 'needs review' };
const outcome = (e) => (Object.hasOwn(OUTCOME, e.result) ? OUTCOME[e.result] : String(e.result || 'unknown').replace(/_/g, ' '));

// Log fields are text from a file; never let one move the cursor or recolour the screen.
const plain = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');

function formatTime(ts, timeZone) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(d);
}

const COLOR = { ok: '32', queued: '36', refused: '31', review: '33', read: '2', other: '0' };
const fit = (s, width) => { const cps = Array.from(s); return cps.length > width ? cps.slice(0, Math.max(0, width)).join('') : s; };

function row(e, { width, color, timeZone }) {
  const detail = e.result === 'rejected' || e.result === 'failed' ? [outcome(e), e.http_status, e.error_code].filter((x) => x != null && x !== '').join(' ') : outcome(e);
  const text = fit(plain(`${formatTime(e.timestamp, timeZone)}  ${verb(e.action).padEnd(12)}  ${String(e.pane || '-').padEnd(10)}  ${detail}`), width);
  return color ? `\x1b[${COLOR[tone(e)]}m${text}\x1b[0m` : text;
}

function render({ entries, width, height, scroll, paused, health, color, timeZone }) {
  const bodyHeight = Math.max(1, height - 3);
  const maxScroll = Math.max(0, entries.length - bodyHeight);
  const back = Math.min(Math.max(0, scroll), maxScroll);
  const end = entries.length - back;
  const rows = entries.slice(Math.max(0, end - bodyHeight), end).map((e) => row(e, { width, color, timeZone }));
  if (!entries.length) rows.push(fit('no portal activity yet: the portal writes a line here for every write it handles', width));
  while (rows.length < bodyHeight) rows.push('');
  const state = paused ? 'paused' : back ? `scrolled back ${back}` : 'live';
  const head = fit(`Herdr portal activity  ·  portal ${health === 'up' ? 'up' : health === 'down' ? 'down' : 'unknown'}  ·  ${state}`, width);
  return [head, '─'.repeat(Math.min(width, 72)), ...rows, fit('q quit · p pause · ↑/↓ PgUp/PgDn scroll · End live', width)];
}

class AuditTail {
  constructor(file, { fromEnd = false } = {}) {
    this.file = file; this.rest = Buffer.alloc(0); this.offset = 0;
    if (fromEnd) { try { this.offset = fs.statSync(file).size; } catch { this.offset = 0; } }
  }

  poll() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0); }
    if (size === this.offset) return [];
    const want = Math.min(size - this.offset, MAX_POLL);
    const buf = Buffer.alloc(want);
    let fd;
    try { fd = fs.openSync(this.file, 'r'); fs.readSync(fd, buf, 0, want, this.offset); } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
    this.offset += want;
    const data = Buffer.concat([this.rest, buf]);
    const cut = data.lastIndexOf(0x0a);
    if (cut < 0) { this.rest = data; return []; }
    this.rest = data.subarray(cut + 1);
    return data.subarray(0, cut).toString('utf8').split('\n').map(parseLine).filter(Boolean);
  }

  static last(file, n) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return []; }
    try {
      let pos = fs.fstatSync(fd).size; let data = Buffer.alloc(0);
      while (pos > 0 && data.toString('utf8').split('\n').length <= n + 1) {
        const len = Math.min(CHUNK, pos); pos -= len;
        const chunk = Buffer.alloc(len); fs.readSync(fd, chunk, 0, len, pos);
        data = Buffer.concat([chunk, data]);
      }
      const lines = data.toString('utf8').split('\n');
      if (pos > 0) lines.shift(); // a line cut by the chunk boundary
      return lines.map(parseLine).filter(Boolean).slice(-n);
    } finally { fs.closeSync(fd); }
  }
}

module.exports = { auditPath, parseLine, verb, tone, formatTime, row, render, AuditTail };
