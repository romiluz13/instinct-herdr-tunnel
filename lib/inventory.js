'use strict';
// Inventory cache for every local Herdr session.
// Follows the documented recovery rule (Socket API > Event subscriptions): events only
// invalidate; state always comes from an authoritative `session.snapshot` read.
//
// Freshness rule: a session is `dirty` (and therefore stale) from the moment it is first seen and from every loss of
// its event stream, until a snapshot that STARTED after the subscription acknowledgement of the current stream
// generation succeeds without a loss in between. Events that arrive during that read trigger a further read, so none
// can be missed after it; a snapshot taken before the acknowledgement cannot cover the events between it and the
// subscription.
//
// Agent lifecycle changes (`pane.agent_status_changed`) are NOT subscribed: that subscription needs one `pane_id` per
// pane, which this cache does not manage. They show up through the poll (config.pollIntervalMs) instead.
const net = require('net');
const { config } = require('./config');
const herdr = require('./herdr');

const SUBSCRIPTIONS = [
  'workspace.created', 'workspace.updated', 'workspace.renamed', 'workspace.moved', 'workspace.reordered', 'workspace.closed',
  'tab.created', 'tab.closed', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.moved', 'pane.exited', 'pane.agent_detected',
  'layout.updated',
].map((type) => ({ type }));

class Inventory {
  constructor(log, { backoffMs = 1000, maxBackoffMs = 15000 } = {}) {
    this.log = log;
    this.backoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.sessions = new Map();
    this.discovery = { at: null, error: null, remote_machines: null };
    this.timers = [];
    this.stopped = false;
  }

  async start() {
    await this.discover();
    this.timers.push(setInterval(() => this.discover().catch(() => {}), config.discoveryIntervalMs));
    this.timers.push(setInterval(() => this.pollAll(), config.pollIntervalMs));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    for (const s of this.sessions.values()) this._closeStream(s);
  }

  _state(info) {
    let s = this.sessions.get(info.name);
    if (!s) {
      s = {
        name: info.name, default: info.default, running: info.running, socket_path: info.socket_path,
        accessible: false, version: null, protocol: null, snapshot: null, snapshot_at: null, snapshot_ms: null,
        last_error: null, refreshing: false, again: false,
        ev: { connected: false, started_at: null, last_event_at: null, events_total: 0, events_lost: 0, reconnects: 0, stream_error: null },
        sock: null, backoff: this.backoffMs, reconnectTimer: null,
        gen: 0, acked_gen: -1, dirty: true, loss_seq: 0,
      };
      this.sessions.set(info.name, s);
    }
    Object.assign(s, { default: info.default, running: info.running, socket_path: info.socket_path });
    return s;
  }

  async discover() {
    try {
      const list = await herdr.listSessions();
      const seen = new Set();
      for (const info of list) {
        seen.add(info.name);
        const s = this._state(info);
        if (info.running && !s.sock && !s.reconnectTimer) this._connectStream(s);
        if (!info.running) { s.accessible = false; s.last_error = 'session not running'; this._markLoss(s); this._closeStream(s); }
      }
      for (const [name, s] of this.sessions) if (!seen.has(name)) { this._closeStream(s); this.sessions.delete(name); }
      this.discovery.at = new Date().toISOString();
      this.discovery.error = null;
    } catch (e) {
      this.discovery.error = `${e.code || 'error'}: ${e.message}`;
      this.log('discovery_failed', { error: this.discovery.error });
    }
    try {
      const out = await herdr.cli(['machine', 'list', '--json']);
      const j = JSON.parse(out);
      const arr = Array.isArray(j) ? j : (j.machines || j.result?.machines || []);
      this.discovery.remote_machines = Array.isArray(arr) ? arr.length : null;
    } catch { this.discovery.remote_machines = null; }
    for (const s of this.sessions.values()) if (s.running && !s.snapshot_at) this.refresh(s.name);
  }

  pollAll() { for (const s of this.sessions.values()) if (s.running) this.refresh(s.name); }

  async refresh(name) {
    const s = this.sessions.get(name);
    if (!s || !s.running) return;
    if (s.refreshing) { s.again = true; return; }
    s.refreshing = true;
    const t0 = Date.now();
    try {
      do {
        s.again = false;
        // What this read can vouch for is fixed before it starts: it must begin after the current stream's acknowledgement.
        const gen = s.gen; const lossSeq = s.loss_seq;
        const afterAck = s.ev.connected && s.acked_gen === gen;
        const r = await herdr.call(s.socket_path, 'session.snapshot', {});
        s.snapshot = r.snapshot;
        s.snapshot_at = new Date().toISOString();
        s.snapshot_ms = Date.now() - t0;
        s.accessible = true;
        s.version = r.snapshot?.version || s.version;
        s.protocol = r.snapshot?.protocol || s.protocol;
        s.last_error = null;
        if (s.dirty && afterAck && s.gen === gen && s.loss_seq === lossSeq && s.ev.connected) s.dirty = false; // an event that arrived meanwhile set `again`: its re-read follows
      } while (s.again);
    } catch (e) {
      s.accessible = false;
      s.last_error = `${e.code || 'error'}: ${e.message}`;
    } finally { s.refreshing = false; }
  }

  async reconcile(name) {
    const s = this.sessions.get(name);
    if (!s || !s.running) return;
    while (s.refreshing) await new Promise((r) => setTimeout(r, 40)); // never reuse a read that started before this call
    await this.refresh(name);
  }

  _markLoss(s) { s.dirty = true; s.loss_seq += 1; }

  _closeStream(s) {
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    if (s.sock) { const k = s.sock; s.sock = null; k.destroy(); }
    s.ev.connected = false;
  }

  _connectStream(s) {
    if (this.stopped || !herdr.validSocketPath(s.socket_path)) return;
    const sock = net.connect(s.socket_path);
    const gen = ++s.gen;
    s.sock = sock;
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'portal_sub', method: 'events.subscribe', params: { subscriptions: SUBSCRIPTIONS } }) + '\n'));
    sock.on('data', (d) => {
      if (s.sock !== sock) return; // a stream that was replaced or closed no longer speaks for this session
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) {
          if (msg.error.code === 'events_lost') s.ev.events_lost += 1;
          s.ev.stream_error = msg.error.code;
          s.ev.connected = false;
          this._markLoss(s);
          this.log('event_stream_error', { session: s.name, code: msg.error.code });
          return sock.destroy();
        }
        if (msg.result && msg.result.type === 'subscription_started') {
          s.acked_gen = gen;
          s.ev.connected = true; s.ev.started_at = new Date().toISOString(); s.ev.stream_error = null; s.backoff = this.backoffMs;
          this.refresh(s.name); // authoritative snapshot taken on another connection after the ack
          continue;
        }
        s.ev.events_total += 1; s.ev.last_event_at = new Date().toISOString();
        this.refresh(s.name); // event == invalidation signal only
      }
    });
    const lost = (why) => {
      if (s.sock !== sock) return;
      s.sock = null; s.ev.connected = false; s.ev.stream_error = s.ev.stream_error || why;
      this._markLoss(s);
      if (this.stopped || !s.running) return;
      s.ev.reconnects += 1;
      s.reconnectTimer = setTimeout(() => { s.reconnectTimer = null; this._connectStream(s); }, s.backoff);
      s.backoff = Math.min(s.backoff * 2, this.maxBackoffMs);
    };
    sock.on('error', (e) => lost(e.code || 'socket_error'));
    sock.on('close', () => lost('closed'));
  }

  _staleness(s, now = Date.now()) {
    const age = s.snapshot_at ? now - Date.parse(s.snapshot_at) : null;
    return { age_ms: age, stale: age === null || age > config.staleAfterMs || !s.accessible || s.dirty };
  }

  sessionView(s, { full = true } = {}) {
    const { age_ms, stale } = this._staleness(s);
    const out = {
      session: s.name, default: s.default, running: s.running, accessible: s.accessible, socket_path: s.socket_path,
      version: s.version, protocol: s.protocol, snapshot_at: s.snapshot_at, snapshot_age_ms: age_ms, stale,
      last_error: s.last_error, event_stream: { ...s.ev, recovering: s.dirty },
    };
    const sn = s.snapshot;
    if (sn) {
      const agentByPane = new Map((sn.agents || []).map((a) => [a.pane_id, a]));
      const panesByTab = new Map();
      for (const p of sn.panes || []) {
        const a = agentByPane.get(p.pane_id);
        const pane = {
          pane_id: p.pane_id, terminal_id: p.terminal_id, workspace_id: p.workspace_id, tab_id: p.tab_id,
          focused: !!p.focused, cwd: p.cwd || null, foreground_cwd: p.foreground_cwd || null,
          agent: p.agent || null, agent_name: a?.name || null, agent_status: p.agent_status || null,
          title: p.terminal_title_stripped || p.terminal_title || null,
        };
        if (!panesByTab.has(p.tab_id)) panesByTab.set(p.tab_id, []);
        panesByTab.get(p.tab_id).push(pane);
      }
      const tabsByWs = new Map();
      for (const t of sn.tabs || []) {
        const tab = { tab_id: t.tab_id, label: t.label || null, workspace_id: t.workspace_id, panes: panesByTab.get(t.tab_id) || [] };
        if (!tabsByWs.has(t.workspace_id)) tabsByWs.set(t.workspace_id, []);
        tabsByWs.get(t.workspace_id).push(tab);
      }
      const workspaces = (sn.workspaces || []).map((w) => ({
        workspace_id: w.workspace_id, label: w.label || null, agent_status: w.agent_status || null, tabs: tabsByWs.get(w.workspace_id) || [],
      }));
      out.counts = { workspaces: (sn.workspaces || []).length, tabs: (sn.tabs || []).length, panes: (sn.panes || []).length, agents: (sn.agents || []).length };
      if (full) out.workspaces = workspaces;
    }
    return out;
  }

  view() {
    const sessions = [...this.sessions.values()].map((s) => this.sessionView(s));
    const gaps = [];
    for (const s of sessions) {
      if (!s.running) gaps.push({ session: s.session, gap: 'session not running: inventory unavailable (not an empty session)' });
      else if (!s.accessible) gaps.push({ session: s.session, gap: `session not accessible: ${s.last_error}` });
      else if (s.event_stream.recovering) gaps.push({ session: s.session, gap: 'event stream recovering: events may have been missed until a snapshot taken after resubscription succeeds' });
      else if (s.stale) gaps.push({ session: s.session, gap: 'data is stale' });
    }
    if (this.discovery.error) gaps.push({ gap: `session discovery failed: ${this.discovery.error}` });
    if (this.discovery.remote_machines) gaps.push({ gap: `${this.discovery.remote_machines} saved remote machine profile(s) exist; remote hosts are NOT covered by this portal` });
    const sum = (k) => sessions.reduce((n, s) => n + (s.counts?.[k] || 0), 0);
    return {
      generated_at: new Date().toISOString(),
      discovery: this.discovery,
      totals: { sessions: sessions.length, accessible: sessions.filter((s) => s.accessible).length, workspaces: sum('workspaces'), tabs: sum('tabs'), panes: sum('panes'), agents: sum('agents') },
      sessions, gaps,
    };
  }

  session(name) { return this.sessions.get(name); }
}

module.exports = { Inventory, SUBSCRIPTIONS };
