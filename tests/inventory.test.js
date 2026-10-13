'use strict';
// Freshness of the inventory cache across event-stream loss, bootstrap and reconnect. A fake Herdr Unix socket only:
// it can hold back subscription acknowledgements, delay snapshots, emit events and drop connections on command.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const herdr = require('../lib/herdr');
const { Inventory } = require('../lib/inventory');

const until = async (fn, ms = 3000, what = 'condition') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timed out waiting for ' + what);
};
const quiet = (ms = 150) => new Promise((r) => setTimeout(r, ms));

function makeFake(sockPath) {
  const f = { acks: 0, subscribes: 0, subs: [], pendingAcks: [], snapshotCalls: [], holdAck: false, snapshotDelayMs: 0, panes: 1, conns: new Set() };
  const snapshot = () => ({
    version: '0.9.3', protocol: 22, focused_pane_id: 'w1:p1',
    workspaces: [{ workspace_id: 'w1', label: 't', agent_status: 'idle' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
    panes: Array.from({ length: f.panes }, (_, i) => ({ pane_id: `w1:p${i + 1}`, terminal_id: `term_${i}`, workspace_id: 'w1', tab_id: 'w1:t1', agent: null, agent_status: 'unknown' })), agents: [],
  });
  const handle = (sock, req) => {
    if (req.method === 'events.subscribe') {
      f.subscribes += 1;
      const ack = () => { f.acks += 1; f.subs.push(sock); sock.write(JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n'); };
      if (f.holdAck) f.pendingAcks.push(ack); else ack();
    } else if (req.method === 'session.snapshot') {
      const snap = snapshot(); // content is fixed when the request arrives; a slow server answers later
      f.snapshotCalls.push({ acksAtRequest: f.acks, panes: f.panes });
      setTimeout(() => sock.write(JSON.stringify({ id: req.id, result: { type: 'session_snapshot', snapshot: snap } }) + '\n'), f.snapshotDelayMs);
    }
  };
  const server = net.createServer((sock) => {
    f.conns.add(sock); sock.on('close', () => { f.conns.delete(sock); f.subs = f.subs.filter((s) => s !== sock); }); sock.on('error', () => {});
    let buf = ''; sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handle(sock, JSON.parse(line)); } });
  });
  fs.rmSync(sockPath, { force: true });
  f.emit = () => f.subs.forEach((s) => s.write(JSON.stringify({ id: 'portal_sub', event: { type: 'pane.updated' } }) + '\n'));
  f.emitLost = () => f.subs.slice().forEach((s) => s.write(JSON.stringify({ id: 'portal_sub', error: { code: 'events_lost', message: 'lost' } }) + '\n'));
  f.dropAll = () => [...f.conns].forEach((s) => s.destroy());
  f.releaseAcks = () => f.pendingAcks.splice(0).forEach((fn) => fn());
  return new Promise((resolve) => server.listen(sockPath, () => resolve(Object.assign(f, { close: () => new Promise((r) => { [...f.conns].forEach((s) => s.destroy()); server.close(r); }) }))));
}

async function harness(t, { sessions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-inv-'));
  const sock = path.join(dir, 'herdr.sock');
  const fake = await makeFake(sock);
  const saved = { listSessions: herdr.listSessions, cli: herdr.cli };
  let list = sessions || [{ name: 's1', default: true, running: true, socket_path: sock, session_dir: dir }];
  herdr.listSessions = async () => list;
  herdr.cli = async () => '[]';
  const inv = new Inventory(() => {}, { backoffMs: 40, maxBackoffMs: 160 });
  t.after(async () => { inv.stop(); Object.assign(herdr, saved); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const view = () => inv.view().sessions[0];
  return { dir, sock, fake, inv, view, setList: (l) => { list = l; } };
}

test('bootstrap: the snapshot that races the subscription never counts as fresh; the first one started after the acknowledgement does', async (t) => {
  const h = await harness(t);
  h.fake.holdAck = true; h.fake.snapshotDelayMs = 20;
  await h.inv.discover();
  await until(() => h.view().snapshot_at !== null, 3000, 'the pre-acknowledgement snapshot');
  assert.equal(h.fake.acks, 0, 'no acknowledgement yet');
  assert.equal(h.view().accessible, true);
  assert.equal(h.view().stale, true, 'a snapshot taken before the subscription is acknowledged cannot vouch for events missed after it');
  assert.equal(h.view().event_stream.recovering, true);
  assert.ok(h.inv.view().gaps.some((g) => /event stream recovering/.test(g.gap)));
  await quiet(); h.inv.pollAll(); await quiet(300);
  assert.equal(h.view().stale, true, 'a poll while the stream is not acknowledged does not clear it either');
  h.fake.releaseAcks();
  await until(() => h.view().stale === false, 3000, 'fresh after acknowledgement');
  assert.ok(h.fake.snapshotCalls.some((c) => c.acksAtRequest >= 1), 'a snapshot was requested after the acknowledgement');
  assert.equal(h.view().event_stream.recovering, false);
});

test('an event that arrives during a slow snapshot triggers another read, so the cache catches up', async (t) => {
  const h = await harness(t);
  await h.inv.discover();
  await until(() => h.view().stale === false, 3000, 'steady state');
  await quiet();
  const before = h.fake.snapshotCalls.length;
  h.fake.snapshotDelayMs = 250;
  h.fake.emit();                                     // invalidation 1: a read starts and captures one pane
  await until(() => h.fake.snapshotCalls.length === before + 1, 2000, 'the read to start');
  h.fake.panes = 2; h.fake.emit();                   // the world changes while that read is in flight
  await until(() => h.view().counts && h.view().counts.panes === 2, 3000, 'the follow-up read');
  assert.ok(h.fake.snapshotCalls.length >= before + 2);
  assert.equal(h.view().stale, false);
});

test('events_lost marks the session stale at once, even though the last snapshot is seconds old at most; it stays so until a post-acknowledgement snapshot', async (t) => {
  const h = await harness(t);
  await h.inv.discover();
  await until(() => h.view().stale === false, 3000, 'steady state');
  assert.ok(h.view().snapshot_age_ms < 2000);
  h.fake.holdAck = true;
  h.fake.emitLost();
  await until(() => h.view().event_stream.events_lost === 1, 2000, 'the loss to be seen');
  assert.equal(h.view().stale, true, 'stale immediately, not after the 15 s age limit');
  assert.equal(h.view().event_stream.recovering, true);
  assert.ok(h.view().snapshot_age_ms < 2000, 'the data is recent; it is the missed events that make it stale');
  await until(() => h.fake.pendingAcks.length === 1, 3000, 'the reconnect to wait for its acknowledgement');
  const during = h.fake.snapshotCalls.length;
  await h.inv.refresh('s1'); // an authoritative read while the new stream is unacknowledged proves nothing about missed events
  assert.ok(h.fake.snapshotCalls.length > during);
  assert.equal(h.view().stale, true);
  h.fake.releaseAcks();
  await until(() => h.view().stale === false, 3000, 'fresh again');
  assert.ok(h.fake.acks >= 2); assert.ok(h.fake.snapshotCalls.at(-1).acksAtRequest >= 2, 'cleared by a snapshot requested after the second acknowledgement');
});

test('a loss during an in-flight refresh is not forgotten when that refresh completes', async (t) => {
  const h = await harness(t);
  await h.inv.discover();
  await until(() => h.view().stale === false, 3000, 'steady state');
  h.fake.snapshotDelayMs = 300; h.fake.holdAck = true;
  const inflight = h.inv.refresh('s1');
  await until(() => h.fake.snapshotCalls.length >= 1 && h.view().stale === false, 1000, 'the refresh to be in flight');
  h.fake.dropAll();                                  // the stream dies while the read is outstanding
  await until(() => h.view().stale === true, 1000, 'the loss');
  await inflight;                                    // the old read completes successfully ...
  assert.equal(h.view().stale, true, '... and must not clear what the loss set');
  await until(() => h.fake.pendingAcks.length >= 1, 3000, 'the reconnect');
  h.fake.snapshotDelayMs = 0; h.fake.releaseAcks();
  await until(() => h.view().stale === false, 3000, 'fresh after the new acknowledgement');
});

test('repeated loss backs off and reconnects every time; each recovery needs its own acknowledgement and snapshot', async (t) => {
  const h = await harness(t);
  await h.inv.discover();
  await until(() => h.view().stale === false, 3000, 'steady state');
  for (let round = 1; round <= 3; round++) {
    h.fake.dropAll();
    await until(() => h.view().event_stream.reconnects >= round, 2000, 'loss ' + round);
    await until(() => h.fake.acks >= round + 1 && h.view().stale === false, 4000, 'recovery ' + round);
  }
  assert.ok(h.view().event_stream.reconnects >= 3);
  assert.ok(h.inv.sessions.get('s1').backoff <= 160, 'the backoff is bounded');
});

test('a session that disappears from discovery leaves no reconnect behind, and stop() cancels a pending one', async (t) => {
  const h = await harness(t);
  await h.inv.discover();
  await until(() => h.view().stale === false, 3000, 'steady state');
  h.fake.holdAck = true; h.fake.dropAll();
  await until(() => h.inv.sessions.get('s1').reconnectTimer !== null || h.fake.subscribes >= 2, 2000, 'a reconnect to be scheduled');
  h.setList([]);
  await h.inv.discover();
  assert.equal(h.inv.sessions.size, 0);
  const connects = h.fake.subscribes;
  await quiet(500);
  assert.equal(h.fake.subscribes, connects, 'no stream is opened for a session that is gone');

  const h2 = await harness(t);
  await h2.inv.discover();
  await until(() => h2.view().stale === false, 3000, 'steady state');
  h2.inv.sessions.get('s1').backoff = 400; h2.fake.dropAll();
  await until(() => h2.inv.sessions.get('s1').reconnectTimer !== null, 2000, 'a reconnect timer');
  const n = h2.fake.subscribes;
  h2.inv.stop();
  await quiet(700);
  assert.equal(h2.fake.subscribes, n, 'stop() cancelled the pending reconnect');
});
