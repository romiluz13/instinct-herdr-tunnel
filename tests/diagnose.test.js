'use strict';
// portalctl diagnose: reading a cloudflared log for the windows in which the tunnel had no connection to Cloudflare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const diagnose = require('../lib/diagnose');

const ROOT = path.join(__dirname, '..');

const at = (hms, rest) => `2026-10-25T${hms}Z ${rest}`;
const registered = (hms, i) => at(hms, `INF Registered tunnel connection connIndex=${i} connection=00000000-0000-0000-0000-00000000000${i} event=0 ip=203.0.113.13 location=ewr16 protocol=quic`);
const terminated = (hms, i, error, level = 'WRN') => at(hms, `${level} Connection terminated error="${error}" connIndex=${i}`);
const starting = (hms) => at(hms, 'INF Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000');
const lines = (...l) => l.join('\n') + '\n';
const IDLE = 'datagram manager error: timeout: no recent network activity';
const UNREACHABLE = (a, b) => `datagram manager error: write udp4 0.0.0.0:${a}->203.0.113.${b}:7844: sendmsg: network is unreachable`;
const times = (w) => [w.firstDropAt, w.downAt, w.upAt].map((t) => t && t.slice(11, 19));

test('outages: the moment the last connection ended and the first one came back is one window, and the first error is its reason', () => {
  const log = lines(
    ...[0, 1, 2, 3].map((i) => registered('08:00:00', i)),
    terminated('08:09:12', 2, 'accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity'),
    terminated('08:09:12', 3, IDLE),
    terminated('08:09:13', 1, IDLE),
    terminated('08:09:15', 0, 'accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity', 'ERR'),
    registered('08:09:53', 2), registered('08:09:53', 0), registered('08:09:53', 1),
  );
  const { windows } = diagnose.outages(log);
  assert.equal(windows.length, 1);
  assert.deepEqual(
    [windows[0].firstDropAt, windows[0].downAt, windows[0].upAt],
    ['2026-10-25T08:09:12Z', '2026-10-25T08:09:15Z', '2026-10-25T08:09:53Z'],
  );
  assert.match(windows[0].reason, /no recent network activity/);
});

test('outages: a replay of 25 Oct 2026 finds the two outages and ignores the connection that dropped and came back', () => {
  const log = lines(
    ...[0, 1, 2, 3].map((i) => registered('08:00:00', i)),
    terminated('08:07:21', 1, IDLE), registered('08:07:40', 1),
    terminated('08:09:12', 2, IDLE), terminated('08:09:12', 3, IDLE), terminated('08:09:13', 1, IDLE), terminated('08:09:15', 0, IDLE, 'ERR'),
    registered('08:09:53', 2), registered('08:09:53', 0), registered('08:09:53', 1),
    at('08:10:01', 'WRN Connection terminated error="control stream error: already connected to this server, trying another address" connIndex=3'),
    terminated('08:16:24', 1, UNREACHABLE(60229, 233), 'ERR'), terminated('08:16:24', 0, UNREACHABLE(51946, 77), 'ERR'), terminated('08:16:25', 2, UNREACHABLE(64384, 23), 'ERR'),
    registered('08:19:45', 1), registered('08:19:45', 0), registered('08:19:45', 2), registered('08:21:06', 3),
  );
  const { windows, drops } = diagnose.outages(log);
  assert.deepEqual(windows.map(times), [
    ['08:09:12', '08:09:15', '08:09:53'],
    ['08:16:24', '08:16:25', '08:19:45'],
  ]);
  assert.equal(windows[1].reason, 'datagram manager error: write udp4 <addr>-><addr>: sendmsg: network is unreachable', 'addresses are not repeated in the reason');
  assert.equal(drops, 8, 'the 08:07 drop and the three at 08:16 count too');
});

test('outages: a connection that drops and comes back while another stays up is not an outage', () => {
  const log = lines(...[0, 1].map((i) => registered('08:00:00', i)), terminated('08:07:21', 1, IDLE), registered('08:07:40', 1));
  const { windows, drops } = diagnose.outages(log);
  assert.deepEqual([windows, drops], [[], 1]);
});

test('outages: connections still down at the end of the log are an open window with no end', () => {
  const log = lines(...[0, 1].map((i) => registered('08:00:00', i)), terminated('08:16:24', 0, IDLE), terminated('08:16:25', 1, IDLE));
  const { windows } = diagnose.outages(log);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].upAt, null);
});

test('outages: a connection that dropped hours ago and never came back is not the first drop of a later outage', () => {
  const log = lines(
    ...[0, 1, 2].map((i) => registered('06:00:00', i)),
    terminated('07:00:00', 2, 'old trouble'),
    terminated('08:16:24', 0, UNREACHABLE(1, 1)), terminated('08:16:25', 1, UNREACHABLE(2, 2)),
    registered('08:19:45', 0),
  );
  const { windows } = diagnose.outages(log);
  assert.deepEqual(windows.map(times), [['08:16:24', '08:16:25', '08:19:45']]);
  assert.match(windows[0].reason, /network is unreachable/);
});

test('outages: a log that shows no registration, or is not a cloudflared log, has no windows and does not fail', () => {
  const noise = diagnose.outages(lines(terminated('08:16:24', 0, IDLE), 'not a log line', ''));
  assert.deepEqual([noise.windows, noise.drops], [[], 0]);
  assert.deepEqual(diagnose.outages(''), { windows: [], drops: 0, from: null, midRun: false });
});

test('outages: a line whose time cannot be read does not make the report fail', () => {
  const log = lines(registered('99:99:99', 0), terminated('99:99:99', 0, IDLE), registered('08:00:00', 0));
  assert.equal(diagnose.outages(log).windows.length, 1);
});

test('outages: in any order of registrations, drops, restarts and noise, windows come in time order, closed ones end after they begin, and only the last can be open', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let run = 0; run < 300; run += 1) {
    let sec = 0; const log = [];
    for (let i = 0; i < 40; i += 1) {
      sec += Math.floor(rand() * 90);
      const hms = new Date(Date.UTC(2026, 9, 25, 0, 0, sec)).toISOString().slice(11, 19);
      const conn = Math.floor(rand() * 4);
      log.push([registered(hms, conn), terminated(hms, conn, IDLE), starting(hms), 'noise'][Math.floor(rand() * 4)]);
    }
    const { windows } = diagnose.outages(lines(...log));
    windows.forEach((w, i) => {
      assert.ok(w.firstDropAt <= w.downAt, `run ${run}: first drop after the window opened`);
      if (w.upAt) assert.ok(w.downAt <= w.upAt, `run ${run}: window ends before it begins`);
      else assert.equal(i, windows.length - 1, `run ${run}: a window left open is not the last`);
      if (i) assert.ok(windows[i - 1].upAt <= w.downAt, `run ${run}: windows overlap`);
    });
  }
});

test('outages: the log says where it starts, and whether that is the start of a cloudflared run, so a report can tell what it cannot have seen', () => {
  const mid = diagnose.outages(lines(registered('08:00:00', 0), terminated('08:09:12', 0, IDLE)));
  assert.deepEqual([mid.from, mid.midRun], ['2026-10-25T08:00:00Z', true]);
  const whole = diagnose.outages(lines(starting('07:59:59'), registered('08:00:00', 0)));
  assert.deepEqual([whole.from, whole.midRun], ['2026-10-25T07:59:59Z', false]);
});

test('outages: a cloudflared that was started again without closing its connections was down from the start until one registers', () => {
  const log = lines(...[0, 1].map((i) => registered('08:00:00', i)), starting('08:30:00'), registered('08:30:09', 0));
  const { windows } = diagnose.outages(log);
  assert.deepEqual(windows.map(times), [['08:30:00', '08:30:00', '08:30:09']]);
  assert.match(windows[0].reason, /restarted/);
});

test('outages: a restart after the connections were closed is the same window, not a second one', () => {
  const log = lines(
    ...[0, 1].map((i) => registered('08:00:00', i)),
    terminated('08:29:58', 0, 'graceful shutdown', 'INF'), terminated('08:29:58', 1, 'graceful shutdown', 'INF'),
    starting('08:30:00'), registered('08:30:09', 0),
  );
  const { windows } = diagnose.outages(log);
  assert.deepEqual(windows.map(times), [['08:29:58', '08:29:58', '08:30:09']]);
  assert.match(windows[0].reason, /graceful shutdown/);
});

test('outages: connections of a stopped cloudflared do not hide the outage of the next one', () => {
  const log = lines(
    ...[0, 1, 2, 3].map((i) => registered('08:00:00', i)),
    starting('08:30:00'), ...[0, 1, 2].map((i) => registered('08:30:09', i)),
    terminated('09:00:00', 0, IDLE), terminated('09:00:01', 1, IDLE), terminated('09:00:01', 2, IDLE),
  );
  const { windows } = diagnose.outages(log);
  assert.deepEqual(windows.map(times), [['08:30:00', '08:30:00', '08:30:09'], ['09:00:00', '09:00:01', null]]);
});

const httpLine = (t, p, extra = {}) => JSON.stringify({ t, event: 'http', m: 'GET', p, s: 200, ms: 3, a: '-', ...extra });

test('lastRequest: the newest request the portal handled, not the health checks that run every few seconds', () => {
  const log = lines(
    httpLine('2026-10-25T08:16:22.568Z', '/api/herdr/pane_read'),
    httpLine('2026-10-25T08:16:25.000Z', '/healthz'), httpLine('2026-10-25T08:50:00.000Z', '/healthz'),
    JSON.stringify({ t: '2026-10-25T08:55:00.000Z', event: 'boot' }),
    'not json',
  );
  assert.deepEqual(diagnose.lastRequest(log), { at: '2026-10-25T08:16:22.568Z', path: '/api/herdr/pane_read' });
  assert.equal(diagnose.lastRequest(lines(httpLine('2026-10-25T08:50:00.000Z', '/healthz'))), null);
  assert.equal(diagnose.lastRequest(''), null);
});

test('lastAuditEntry: the time of the newest audit line, whatever it records', () => {
  const audit = lines(JSON.stringify({ timestamp: '2026-10-25T08:07:31.223Z', action: 'herdr.agent_prompt' }), JSON.stringify({ timestamp: '2026-10-25T08:14:07.370Z', action: 'herdr.agent_prompt' }), 'torn li');
  assert.equal(diagnose.lastAuditEntry(audit), '2026-10-25T08:14:07.370Z');
  assert.equal(diagnose.lastAuditEntry(''), null);
});

test('sleepEvents: sleep and wake lines of pmset, with their time as an instant', () => {
  const pm = lines(
    '2026-10-20 17:55:24 +0300 Wake Requests       \t[*process=dasd request=SleepService deltaSecs=1016]',
    '2026-10-20 17:55:56 +0300 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to smc.sysState.Wake(0x70070000) Using AC (Charge:13%)',
    '2026-10-20 17:55:57 +0300 Wake                \tDarkWake to FullWake from Deep Idle [CDNVAP] : due to Notification Using AC (Charge:13%)',
    '2026-10-25 03:20:12 +0200 Sleep               \tEntering Sleep state due to \'Maintenance Sleep\':TCPKeepAlive=active Using AC (Charge:100%) 1 secs',
    '2026-10-25 09:30:43 +0200 Assertions          \tPID 752(sharingd) Released PreventUserIdleSystemSleep "Handoff"',
  );
  assert.deepEqual(diagnose.sleepEvents(pm), [
    { at: '2026-10-20T14:55:56.000Z', kind: 'DarkWake' },
    { at: '2026-10-20T14:55:57.000Z', kind: 'Wake' },
    { at: '2026-10-25T01:20:12.000Z', kind: 'Sleep' },
  ]);
  assert.deepEqual(diagnose.sleepEvents(''), []);
});

test('stripHosts: a URL and the named hostname never reach the output', () => {
  const text = 'dest=https://portal.example.test/api/herdr/pane_read?x=1 and portal.example.test again, plus PORTAL.EXAMPLE.TEST';
  const out = diagnose.stripHosts(text, ['portal.example.test']);
  assert.ok(!/example\.test/i.test(out), out);
  assert.match(out, /<url>/);
  assert.equal(diagnose.stripHosts('nothing to hide', []), 'nothing to hide');
});

const REPORT = {
  now: '2026-10-25T08:58:00.000Z',
  portal: { loaded: true, pid: 36614, healthz: 200 },
  tunnel: { ready: 4, probe: 'ready', metrics: '127.0.0.1:20241' },
  request: { at: '2026-10-25T08:16:22.568Z', path: '/api/herdr/pane_read' },
  audit: '2026-10-25T08:14:07.370Z',
  outages: {
    source: 'cloudflared.err.log', drops: 8, from: '2026-10-13T14:59:38Z',
    windows: [
      { firstDropAt: '2026-10-25T08:09:12Z', downAt: '2026-10-25T08:09:15Z', upAt: '2026-10-25T08:09:53Z', reason: IDLE },
      { firstDropAt: '2026-10-25T08:16:24Z', downAt: '2026-10-25T08:16:25Z', upAt: '2026-10-25T08:19:45Z', reason: 'datagram manager error: write udp4 <addr>-><addr>: sendmsg: network is unreachable' },
    ],
  },
  sleep: [{ at: '2026-10-20T14:55:57.000Z', kind: 'Wake' }],
  network: { iface: 'en0', gateway: '192.168.1.1', address: '192.168.1.14' },
};

test('render: one line per fact, outage windows with their length and first error, and a reminder that a 302 proves nothing', () => {
  assert.deepEqual(diagnose.render(REPORT, { timeZone: 'UTC' }), [
    'Tunnel diagnosis, 2026-10-25 08:58:00 (UTC). Read-only: no token read, nothing changed.',
    'portal   loaded, pid 36614, /healthz 200',
    'tunnel   4 connections ready (metrics 127.0.0.1:20241)',
    'traffic  last request handled 08:16:22 (41 min ago, /api/herdr/pane_read); last audit entry 08:14:07',
    'outages  2 in the last 24 h, 3 min 58 s without any connection, from cloudflared.err.log (8 connection drops in the log)',
    '  08:09:15 to 08:09:53  38 s  (first drop 08:09:12)  datagram manager error: timeout: no recent network activity',
    '  08:16:25 to 08:19:45  3 min 20 s  (first drop 08:16:24)  datagram manager error: write udp4 <addr>-><addr>: sendmsg: network is unreachable',
    'sleep    none in the last 24 h',
    'network  default route en0 via 192.168.1.1, address 192.168.1.14',
    'note     If the public address is behind Cloudflare Access, a 302 from it is Access answering and does not show the tunnel is up; "connections ready" does.',
  ]);
});

test('render: what could not be read is said plainly, an outage still open is marked, and no connections ready is called an outage', () => {
  const bare = {
    now: '2026-10-25T08:58:00.000Z', portal: { loaded: false, pid: null, healthz: null }, tunnel: { ready: 0, probe: 'ready', metrics: '127.0.0.1:20241' },
    request: null, audit: null, outages: { source: null, drops: 0, from: null, windows: [] }, sleep: null, network: null,
  };
  const out = diagnose.render(bare, { timeZone: 'UTC' });
  assert.equal(out[1], 'portal   not loaded, /healthz did not answer');
  assert.equal(out[2], 'tunnel   NO CONNECTIONS ready: the public address cannot reach the portal (metrics 127.0.0.1:20241)');
  assert.equal(out[3], 'traffic  no request in the portal log; no entry in the audit log');
  assert.equal(out[4], 'outages  no cloudflared log found (set HERDR_PORTAL_TUNNEL_LOG)');
  assert.equal(out[5], 'sleep    not available (pmset did not answer, or this is not macOS)');
  assert.equal(out[6], 'network  not available (route gave no answer, or this is not macOS)');
  const open = { ...bare, tunnel: { ready: null, probe: 'unreachable', metrics: '127.0.0.1:20241' }, sleep: [], outages: { source: 'tunnel.err.log', drops: 2, from: '2026-10-20T00:00:00Z', windows: [{ firstDropAt: '2026-10-25T08:50:00Z', downAt: '2026-10-25T08:50:02Z', upAt: null, reason: IDLE }] } };
  const reopened = diagnose.render(open, { timeZone: 'UTC' });
  assert.equal(reopened[2], 'tunnel   metrics unreachable at 127.0.0.1:20241 (cloudflared not running, or serving metrics elsewhere: HERDR_PORTAL_TUNNEL_METRICS)');
  assert.equal(reopened[5], '  08:50:02 to now  still down, 7 min 58 s so far  (first drop 08:50:00)  datagram manager error: timeout: no recent network activity');
  assert.equal(reopened[6], 'sleep    none in the last 24 h', 'a sleep log that was read and holds nothing is "none", not "not available"');
});

test('render: a log that could not be read, or holds no cloudflared lines, is not reported as "none"', () => {
  const read = (outages) => diagnose.render({ ...REPORT, outages }, { timeZone: 'UTC' })[4];
  assert.equal(read({ source: 'tunnel.log', unreadable: true }), 'outages  could not read tunnel.log');
  assert.equal(read({ source: 'tunnel.log', drops: 0, from: null, windows: [] }), 'outages  no cloudflared lines in tunnel.log');
});

test('render: a log that begins in the middle of a run says that connections which registered before are not counted', () => {
  const mid = diagnose.render({ ...REPORT, outages: { ...REPORT.outages, midRun: true } }, { timeZone: 'UTC' });
  assert.ok(mid.includes('  (the log read begins mid-run, at 10-13 14:59:38; connections that registered before then are not counted)'), mid.join('\n'));
  assert.ok(!diagnose.render(REPORT, { timeZone: 'UTC' }).some((l) => /begins mid-run/.test(l)));
});

test('render: portal and audit logs that could not be read, and a machine with no default route, are said plainly', () => {
  const out = diagnose.render({ ...REPORT, request: 'unreadable', audit: 'unreadable', network: { noRoute: true } }, { timeZone: 'UTC' });
  assert.equal(out[3], 'traffic  the portal log could not be read; the audit log could not be read');
  assert.equal(out[out.length - 2], 'network  no default route');
});

test('render: an outage that began days ago and has not ended is still listed, and counts for the 24 h it overlaps', () => {
  const stuck = { ...REPORT, outages: { ...REPORT.outages, windows: [{ firstDropAt: '2026-10-22T08:49:59Z', downAt: '2026-10-22T08:50:02Z', upAt: null, reason: IDLE }] } };
  const out = diagnose.render(stuck, { timeZone: 'UTC' });
  assert.equal(out[4], 'outages  1 in the last 24 h, 24 h without any connection, from cloudflared.err.log (8 connection drops in the log)');
  assert.match(out[5], /^ {2}10-22 08:50:02 to now {2}still down, 72 h 7 min so far /);
});

test('render: a log that begins inside the last 24 h says so, because earlier outages cannot be in it', () => {
  const fresh = { ...REPORT, outages: { ...REPORT.outages, from: '2026-10-25T07:00:00Z' } };
  assert.ok(diagnose.render(fresh, { timeZone: 'UTC' }).includes('  (the log read starts 07:00:00, so earlier outages are not in it)'));
  assert.ok(!diagnose.render(REPORT, { timeZone: 'UTC' }).some((l) => /the log read starts/.test(l)), 'a log that reaches back further than 24 h needs no note');
});

test('render: a request logged a moment after the report was taken is "0 s ago", never a negative time', () => {
  const out = diagnose.render({ ...REPORT, request: { at: '2026-10-25T08:58:06.000Z', path: '/api/health' } }, { timeZone: 'UTC' });
  assert.match(out[3], /^traffic {2}last request handled 08:58:06 \(0 s ago, \/api\/health\); /);
});

test('render: a window or entry from an earlier day carries its date, so times that pass midnight stay in order', () => {
  const report = { ...REPORT, audit: '2026-10-24T23:50:00.000Z', outages: { ...REPORT.outages, windows: [
    { firstDropAt: '2026-10-24T22:55:55Z', downAt: '2026-10-24T22:55:56Z', upAt: '2026-10-24T22:55:58Z', reason: IDLE },
    { firstDropAt: '2026-10-24T23:59:58Z', downAt: '2026-10-25T00:00:01Z', upAt: '2026-10-25T00:00:03Z', reason: IDLE },
  ] } };
  const out = diagnose.render(report, { timeZone: 'UTC' });
  assert.match(out[3], /last audit entry 10-24 23:50:00$/);
  assert.match(out[5], /^ {2}10-24 22:55:56 to 22:55:58 {2}2 s {2}\(first drop 22:55:55\) /);
  assert.match(out[6], /^ {2}00:00:01 to 00:00:03 {2}2 s {2}\(first drop 10-24 23:59:58\) /, 'today needs no date; a moment on another day than its window does');
});

const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
// Not the shared run helper: spawnSync would block the event loop that serves the fake portal and metrics this command asks.
const runAsync = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { cwd: ROOT, env }); let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d)); c.on('close', (status) => resolve({ status, stdout, stderr }));
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-diag-'));
  const state = path.join(home, 'st'); const logs = path.join(home, 'lg');
  fs.mkdirSync(path.join(state, 'secrets'), { recursive: true }); fs.mkdirSync(logs, { recursive: true });
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const stamp = (min, rest) => `${ago(min).replace(/\.\d+Z$/, 'Z')} ${rest}`;
  const outage = (error) => lines(
    stamp(90, 'INF Registered tunnel connection connIndex=0 connection=aa event=0 ip=203.0.113.13 location=ewr16 protocol=quic'),
    stamp(40, `ERR Connection terminated error="${error}" connIndex=0`),
    stamp(38, 'INF Registered tunnel connection connIndex=0 connection=bb event=0 ip=203.0.113.13 location=ewr16 protocol=quic'),
  );
  // A machine with a real cloudflared service has its own log, which the report reads if it was written to last; the fixture log is dated ahead of it.
  const touch = (file, days) => { const t = new Date(Date.now() + days * 86400000); fs.utimesSync(file, t, t); };
  return { home, state, logs, ago, stamp, outage, touch, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

async function runDiagnose(fx, extraEnv = {}) {
  const lc = path.join(fx.home, 'launchctl');
  fs.writeFileSync(lc, '#!/bin/sh\nif [ "$1" = print ] && [ "$2" = "gui/$(id -u)/dev.test-portal" ]; then printf "state = running\\npid = 4242\\n"; exit 0; fi\nexit 113\n', { mode: 0o755 });
  const healthz = await serve((req, res) => { res.end(JSON.stringify({ portal: 'up' })); });
  const metrics = await serve((req, res) => { res.statusCode = req.url === '/ready' ? 200 : 404; res.end(JSON.stringify({ status: 200, readyConnections: 3 })); });
  try {
    return await runAsync(['bin/portalctl', 'diagnose'], {
      PATH: process.env.PATH, HOME: fx.home, HERDR_PORTAL_STATE_DIR: fx.state, HERDR_PORTAL_LOG_DIR: fx.logs, HERDR_PORTAL_LAUNCHCTL: lc, HERDR_PORTAL_LAUNCHD_PREFIX: 'dev.test-portal',
      HERDR_PORTAL_PORT: String(healthz.address().port), HERDR_PORTAL_TUNNEL_METRICS: `127.0.0.1:${metrics.address().port}`, ...extraEnv,
    });
  } finally { healthz.close(); metrics.close(); }
}

test('portalctl diagnose: reads the portal, the connector and its log, prints the outage, and shows neither the token nor the hostname', async () => {
  const fx = fixture();
  const token = path.join(fx.state, 'secrets', 'portal-token');
  fs.writeFileSync(token, 'SECRET-TOKEN-VALUE\n'); fs.chmodSync(token, 0o000);
  fs.writeFileSync(path.join(fx.state, 'tunnel.json'), JSON.stringify({ mode: 'named', hostname: 'portal.example.test' }));
  fs.writeFileSync(path.join(fx.logs, 'portal.log'), lines(httpLine(fx.ago(30), '/api/herdr/pane_read'), httpLine(fx.ago(1), '/healthz')));
  fs.writeFileSync(path.join(fx.logs, 'audit.jsonl'), lines(JSON.stringify({ timestamp: fx.ago(32), action: 'herdr.agent_prompt' })));
  const log = path.join(fx.logs, 'tunnel.log');
  fs.writeFileSync(log, fx.outage(IDLE) + fx.stamp(37, 'ERR Request failed error="boom" connIndex=0 dest=https://portal.example.test/api/herdr/pane_read event=0\n'));
  fx.touch(log, 1);
  try {
    const r = await runDiagnose(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^portal {3}loaded, pid 4242, \/healthz 200$/m);
    assert.match(r.stdout, /^tunnel {3}3 connections ready \(metrics 127\.0\.0\.1:\d+\)$/m);
    assert.match(r.stdout, /^traffic {2}last request handled \d\d:\d\d:\d\d \(30 min ago, \/api\/herdr\/pane_read\); last audit entry \d\d:\d\d:\d\d$/m);
    assert.match(r.stdout, /^outages {2}1 in the last 24 h, 2 min without any connection, from tunnel\.log \(1 connection drop in the log\)$/m);
    assert.match(r.stdout, /\(first drop \d\d:\d\d:\d\d\) {2}datagram manager error: timeout: no recent network activity$/m);
    assert.ok(!/SECRET-TOKEN-VALUE/.test(r.stdout + r.stderr), 'the token is never printed');
    assert.ok(!/example\.test/.test(r.stdout + r.stderr), 'the hostname is never printed');
  } finally { fs.chmodSync(token, 0o600); fx.cleanup(); }
});

test('portalctl diagnose: of several connector logs it reads the one written to last, unless HERDR_PORTAL_TUNNEL_LOG names one', async () => {
  const fx = fixture();
  const own = path.join(fx.logs, 'tunnel.log');
  const service = path.join(fx.home, 'Library', 'Logs', 'com.cloudflare.cloudflared.err.log');
  const named = path.join(fx.home, 'named.log');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  fs.writeFileSync(own, fx.outage('stale own log')); fx.touch(own, -2);
  fs.writeFileSync(service, fx.outage('fresh service log')); fx.touch(service, 1);
  fs.writeFileSync(named, fx.outage('named log')); fx.touch(named, -3);
  try {
    const auto = await runDiagnose(fx);
    assert.match(auto.stdout, /from com\.cloudflare\.cloudflared\.err\.log /);
    assert.match(auto.stdout, /fresh service log/);
    const explicit = await runDiagnose(fx, { HERDR_PORTAL_TUNNEL_LOG: named });
    assert.match(explicit.stdout, /from named\.log /);
    assert.match(explicit.stdout, /named log/);
    const missing = await runDiagnose(fx, { HERDR_PORTAL_TUNNEL_LOG: path.join(fx.home, 'nowhere.log') });
    assert.match(missing.stdout, /^outages {2}could not read nowhere\.log$/m, 'a named log that is not there is not replaced by another');
    assert.ok(!/fresh service log|stale own log/.test(missing.stdout));
  } finally { fx.cleanup(); }
});

test('portalctl diagnose: a log it cannot read is reported as unreadable, never as a quiet day', async () => {
  const fx = fixture();
  const log = path.join(fx.logs, 'tunnel.log');
  const portalLog = path.join(fx.logs, 'portal.log');
  fs.writeFileSync(log, fx.outage(IDLE)); fx.touch(log, 1); fs.chmodSync(log, 0o000);
  fs.writeFileSync(portalLog, ''); fs.chmodSync(portalLog, 0o000);
  try {
    const r = await runDiagnose(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^outages {2}could not read tunnel\.log$/m);
    assert.match(r.stdout, /^traffic {2}the portal log could not be read; no entry in the audit log$/m, 'audit.jsonl was never written in this fixture, which is not a read error');
  } finally { fs.chmodSync(log, 0o600); fs.chmodSync(portalLog, 0o600); fx.cleanup(); }
});
