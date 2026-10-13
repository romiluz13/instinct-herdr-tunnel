'use strict';
// Integration tests against a FAKE Herdr (socket + CLI). Real panes are never touched here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fake = require('./fixtures/fake-herdr-server');

const ROOT = path.join(__dirname, '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');

function req(port, method, p, { token = TOKEN, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, json: j, text: b, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function boot(dir, port, { version, decision, decisionEnv, strict } = {}) {
  // The portal gives the CLI a clean env on purpose, so the fake's settings are baked into a wrapper script.
  const wrapper = path.join(dir, 'herdr');
  fs.writeFileSync(wrapper, `#!/bin/sh\nFAKE_HERDR_DIR='${dir}' FAKE_HERDR_VERSION='${version || '0.9.3'}' exec '${process.execPath}' '${path.join(__dirname, 'fixtures', 'fake-herdr-cli.js')}' "$@"\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: dir, HERDR_PORTAL_STATE_DIR: path.join(dir, 'state'), HERDR_PORTAL_LOG_DIR: path.join(dir, 'logs'), HERDR_PORTAL_PORT: String(port), HERDR_BIN: wrapper };
  if (decision) env.HERDR_PORTAL_ENABLE_AGENT_DECISION = '1'; // agent_decision is off unless the operator opts in
  if (decisionEnv !== undefined) env.HERDR_PORTAL_ENABLE_AGENT_DECISION = decisionEnv;
  if (strict) env.HERDR_PORTAL_STRICT_VERSION = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (out.includes('"listening"')) { await new Promise((r) => setTimeout(r, 400)); return { child, out: () => out }; }
    if (child.exitCode !== null) throw new Error('server exited: ' + out);
  }
  throw new Error('server did not start: ' + out);
}
const stop = (p) => new Promise((r) => { if (p.child.exitCode !== null) return r(); p.child.once('exit', r); p.child.kill('SIGTERM'); });

async function setup(t, opts) {
  const dir = fs.mkdtempSync('/tmp/hp-');
  fs.mkdirSync(path.join(dir, 'state', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'state', 'secrets', 'portal-token'), TOKEN + '\n', { mode: 0o600 });
  const herdr = await fake.start(path.join(dir, 'herdr.sock'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  let proc = await boot(dir, port, opts);
  const ctx = { dir, herdr, port, get proc() { return proc; }, restart: async () => { await stop(proc); proc = await boot(dir, port, opts); } };
  t.after(async () => { await stop(proc).catch(() => {}); await herdr.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return ctx;
}

const wb = (extra = {}) => ({ session: 'default', pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });

test('authentication and public surface', async (t) => {
  const c = await setup(t);
  const login = await req(c.port, 'GET', '/', { token: null });
  assert.equal(login.status, 200);
  for (const asset of ['/', '/app.js', '/style.css']) {
    const r = await req(c.port, 'GET', asset, { token: null });
    assert.equal(r.status, 200, asset);
    assert.ok(!/w1:p[0-9]|term_aa|\/tmp\/test|hello from/.test(r.text), asset + ' carries no inventory');
  }
  assert.equal(login.headers['cache-control'], 'no-store');
  for (const p of ['/api/inventory', '/api/health', '/api/herdr', '/api/herdr/agent_list?session=default', '/api/ledger']) {
    const r = await req(c.port, 'GET', p, { token: null }); assert.equal(r.status, 401, p); assert.ok(!r.text.includes('w1:p1'));
  }
  assert.equal((await req(c.port, 'GET', '/api/inventory', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await req(c.port, 'GET', '/api/inventory', { token: TOKEN + 'A' })).status, 401);
  assert.equal((await req(c.port, 'GET', '/api/inventory', { headers: { Host: 'evil.example.com' } })).status, 421);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: {}, headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await req(c.port, 'GET', '/api/inventory')).status, 200);
  assert.equal(c.herdr.writes().length, 0);
});

test('rate limiting of failed authentication', async (t) => {
  const c = await setup(t);
  let last;
  for (let i = 0; i < 10; i++) last = await req(c.port, 'GET', '/api/inventory', { token: 'bad-token-bad-token-bad-token-1234' });
  assert.equal(last.status, 429);
  assert.equal((await req(c.port, 'GET', '/api/inventory')).status, 429, 'even a valid token is blocked during lockout from the same client');
});

test('routing rejects unknown actions, wrong verbs and unknown params before any work', async (t) => {
  const c = await setup(t);
  assert.equal((await req(c.port, 'GET', '/api/herdr/exec')).status, 404);
  assert.equal((await req(c.port, 'POST', '/api/herdr/raw', { body: { method: 'pane.close' } })).status, 404);
  assert.equal((await req(c.port, 'GET', '/api/herdr/pane_run?session=default')).status, 405);
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_list', { body: { session: 'default' } })).status, 405);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: 'x', command: 'rm -rf /' }) })).json.error.code, 'unknown_param');
  assert.equal((await req(c.port, 'GET', '/api/herdr/agent_list')).json.error.code, 'missing_param');
  assert.equal((await req(c.port, 'GET', '/api/herdr/agent_list?session=nope')).status, 404);
  assert.equal(c.herdr.writes().length, 0);
});

test('pane_read only allows visible and detection', async (t) => {
  const c = await setup(t);
  const ok = await req(c.port, 'GET', '/api/herdr/pane_read?session=default&pane_id=w1:p1');
  assert.equal(ok.status, 200); assert.equal(ok.json.source, 'visible');
  assert.equal((await req(c.port, 'GET', '/api/herdr/pane_read?session=default&pane_id=w1:p1&source=detection')).status, 200);
  for (const s of ['recent', 'recent-unwrapped', 'recent_unwrapped', 'ansi', '']) {
    const r = await req(c.port, 'GET', `/api/herdr/pane_read?session=default&pane_id=w1:p1&source=${s}`);
    assert.equal(r.status, 400, s);
  }
  assert.ok(c.herdr.calls.filter((x) => x.method === 'pane.read').every((x) => ['visible', 'detection'].includes(x.params.source)));
});

test('write validation: explicit session, pane, terminal, keys, control characters', async (t) => {
  const c = await setup(t);
  for (const drop of ['session', 'pane_id', 'expect_terminal_id', 'request_id', 'idempotency_key']) {
    const b = wb({ text: 'echo hi' }); delete b[drop];
    const r = await req(c.port, 'POST', '/api/herdr/pane_run', { body: b }); assert.equal(r.status, 400, drop); assert.equal(r.json.error.code, 'missing_param');
  }
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: 'a\nb' }) })).status, 400);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text: 'a\u001b[31m' }) })).status, 400);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ keys: ['prefix+x'] }) })).status, 400);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ keys: ['ctrl+c', 'enter', 'f5', 'a'] }) })).status, 200);
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_start', { body: wb({ name: 'Bad Name', kind: 'claude' }) })).status, 400);
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_start', { body: wb({ name: 'ok-name', kind: 'rm' }) })).status, 400);
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_start', { body: wb({ name: 'ok-name', kind: 'claude', args: ['--dangerously-skip-permissions'] }) })).json.error.code, 'unknown_param');
  assert.equal(c.herdr.writes().length, 1, 'only the one valid send_keys reached Herdr');
  const wrongPane = await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ pane_id: 'w9:p9', text: 'x' }) });
  assert.equal(wrongPane.status, 404);
  const wrongTerm = await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ expect_terminal_id: 'term_ffff', text: 'x' }) });
  assert.equal(wrongTerm.status, 409); assert.equal(wrongTerm.json.error.code, 'target_changed');
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ session: 'other', text: 'x' }) })).status, 404);
  assert.equal(c.herdr.writes().length, 1);
});

test('blocked agents and agent panes cannot be reached through any write action', async (t) => {
  const c = await setup(t);
  const blocked = { pane_id: 'w1:p3', expect_terminal_id: 'term_aa03' };
  const calls = [
    ['agent_prompt', { text: 'please continue' }], ['agent_send_keys', { keys: ['esc'] }],
    ['pane_run', { text: 'y' }], ['pane_send_text', { text: 'y' }], ['pane_send_keys', { keys: ['enter'] }],
  ];
  for (const [a, extra] of calls) {
    const r = await req(c.port, 'POST', '/api/herdr/' + a, { body: wb({ ...blocked, ...extra }) });
    assert.equal(r.status, 409, a); assert.equal(r.json.error.code, 'blocked_requires_decision', a);
    assert.equal(r.json.error.agent_status, 'blocked'); assert.match(r.json.error.visible_text, /Allow this command/);
  }
  // pane_* on a non-blocked pane that hosts an agent is refused as well (would bypass agent state checks)
  const idle = { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02' };
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ ...idle, text: 'x' }) })).json.error.code, 'pane_hosts_agent');
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', text: 'hi' }) })).json.error.code, 'no_agent');
  assert.equal(c.herdr.writes().length, 0, 'nothing was sent to any pane');
  for (const k of [['enter'], ['y'], ['1'], ['ctrl+c', 'enter']]) assert.equal((await req(c.port, 'POST', '/api/herdr/agent_send_keys', { body: wb({ ...idle, keys: k }) })).status, 400, 'confirming key refused: ' + k);
  c.herdr.state.panes['w1:p2'].agent_status = 'unknown';
  const unk = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text: 'hi' }) });
  assert.equal(unk.json.error.code, 'agent_state_not_writable');
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_send_keys', { body: wb({ ...idle, keys: ['esc'] }) })).json.error.code, 'agent_state_not_writable');
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  assert.equal(c.herdr.writes().length, 0, 'still nothing sent');
  // an idle agent can be prompted
  const ok = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text: 'hello' }) });
  assert.equal(ok.status, 200); assert.equal(ok.json.status, 'input_sent'); assert.equal(ok.json.detail.task_completed, null);
  // there is no free-form approve route; answering a dialog goes through agent_decision only
  assert.equal((await req(c.port, 'POST', '/api/herdr/approve', { body: { approved: true } })).status, 404);
});

test('pane_run passes text as one argv element: no shell, no HERDR_* env, no leading dash', async (t) => {
  const c = await setup(t);
  const evil = 'echo $(touch ' + path.join(c.dir, 'PWNED') + '); `id`; --version';
  const r = await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: evil }) });
  assert.equal(r.status, 200, r.text);
  const calls = fs.readFileSync(path.join(c.dir, 'cli-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: '--help' }) })).status, 400);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ['--session', 'default', 'pane', 'run', 'w1:p1', evil]);
  assert.deepEqual(calls[0].env_herdr, []);
  assert.ok(!fs.existsSync(path.join(c.dir, 'PWNED')));
});

test('replay safety: same key never re-sends, changed payload rejected, survives restart', async (t) => {
  const c = await setup(t);
  const body = wb({ text: 'marker' });
  const a = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body });
  assert.equal(a.json.status, 'input_sent'); assert.equal(a.json.replayed, false);
  const b = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: { ...body, request_id: 'req-second-attempt' } });
  assert.equal(b.json.replayed, true); assert.equal(b.json.original_request_id, body.request_id);
  const conflict = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: { ...body, text: 'different' } });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'idempotency_conflict');
  assert.equal(c.herdr.writes().length, 1);
  await c.restart();
  const d = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body });
  assert.equal(d.json.replayed, true); assert.equal(d.json.status, 'input_sent');
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: { ...body, text: 'different' } })).status, 409);
  assert.equal(c.herdr.writes().length, 1, 'no second send, even after restart');
});

test('concurrent identical requests execute once', async (t) => {
  const c = await setup(t);
  const body = wb({ text: 'once' });
  const rs = await Promise.all([1, 2, 3, 4].map((i) => req(c.port, 'POST', '/api/herdr/pane_send_text', { body: { ...body, request_id: 'req-par-' + i + '-xxxx' } })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => !r.json.replayed).length, 1);
  assert.equal(c.herdr.writes().length, 1);
});

test('uncertain outcome becomes needs_review and is never retried', async (t) => {
  const c = await setup(t);
  c.herdr.state.hangOn = 'pane.send_text';
  const body = wb({ text: 'maybe' });
  const a = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body });
  assert.equal(a.json.status, 'needs_review'); assert.notEqual(a.status, 200);
  c.herdr.state.hangOn = null;
  const b = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body });
  assert.equal(b.json.status, 'needs_review'); assert.equal(b.json.replayed, true);
  assert.equal(c.herdr.writes().length, 1, 'the retry with the same key did not send again');
});

test('crash between "maybe sent" and "result recorded" is finalized as needs_review at boot', async (t) => {
  const c = await setup(t);
  const key = 'idem-crashed-before-result';
  const body = wb({ text: 'crash', idempotency_key: key });
  const { payloadHash } = require('../lib/ledger');
  const { request_id, idempotency_key, ...payload } = body;
  await stop(c.proc);
  fs.appendFileSync(path.join(c.dir, 'state', 'ledger.jsonl'), JSON.stringify({ t: 'pending', request_id, idempotency_key: key, payload_hash: payloadHash('herdr.pane_send_text', payload), action: 'herdr.pane_send_text', session: 'default', target: { pane_id: 'w1:p1' }, started_at: new Date().toISOString() }) + '\n');
  await c.restart();
  const r = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body });
  assert.equal(r.json.status, 'needs_review'); assert.equal(r.json.replayed, true);
  assert.match(JSON.stringify(r.json.detail), /portal_restarted/);
  assert.equal(c.herdr.writes().length, 0);
});

test('writes are refused when the installed CLI and the running server are different builds; reads keep working', async (t) => {
  const c = await setup(t, { version: '0.9.4' });
  const r = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text: 'x' }) });
  assert.equal(r.status, 503); assert.equal(r.json.error.code, 'writes_disabled');
  assert.equal((await req(c.port, 'GET', '/api/herdr/agent_list?session=default')).status, 200, 'reads still work');
  assert.equal(c.herdr.writes().length, 0);
});

test('inventory: per-session counts, freshness, events invalidate then reconcile', async (t) => {
  const c = await setup(t);
  const inv = (await req(c.port, 'GET', '/api/inventory')).json;
  assert.equal(inv.totals.sessions, 1); assert.equal(inv.totals.panes, 3); assert.equal(inv.totals.agents, 2);
  const s = inv.sessions[0]; assert.equal(s.session, 'default'); assert.equal(s.accessible, true); assert.equal(s.stale, false);
  assert.equal(s.event_stream.connected, true);
  assert.equal(s.workspaces[0].tabs[0].panes.find((p) => p.pane_id === 'w1:p3').agent_status, 'blocked');
  c.herdr.state.panes['w1:p4'] = { pane_id: 'w1:p4', terminal_id: 'term_aa04', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp', agent: null, agent_status: 'unknown' };
  c.herdr.emit();
  await new Promise((r) => setTimeout(r, 600));
  const after = (await req(c.port, 'GET', '/api/herdr/events_snapshot')).json;
  assert.equal(after.totals.panes, 4); assert.ok(after.sessions[0].event_stream.events_total >= 1);
  delete c.herdr.state.panes['w1:p4'];
  const rec = await req(c.port, 'POST', '/api/herdr/events_reconcile', { body: {} });
  assert.equal(rec.json.totals.panes, 3);
  // Herdr goes away: session turns inaccessible and stale, never "empty"
  await c.herdr.close();
  await new Promise((r) => setTimeout(r, 3800));
  const down = (await req(c.port, 'GET', '/api/inventory')).json;
  assert.equal(down.sessions[0].accessible, false);
  assert.ok(down.gaps.some((g) => /not accessible/.test(g.gap)));
});

test('review fixes: prompts, foreground shell, torn ledger, Origin null, uncertain waits, version gate', async (t) => {
  const c = await setup(t);
  const idle = { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02' };
  for (const text of ['\n', ' ', 'y', 'Yes', '1', 'ok']) assert.equal((await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text }) })).status, 400, JSON.stringify(text));
  assert.equal(c.herdr.writes().length, 0);
  // a working agent may pop a dialog any moment: prompts need idle/done
  c.herdr.state.panes['w1:p2'].agent_status = 'working';
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text: 'hello there' }) })).json.error.code, 'agent_state_not_writable');
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_send_keys', { body: wb({ ...idle, keys: ['ctrl+c'] }) })).status, 200, 'interrupt keys still allowed while working');
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  // a pane whose foreground is not a shell (e.g. an agent Herdr has not classified yet)
  c.herdr.state.fg['w1:p1'] = 'claude';
  const shellOnly = { pane_id: 'w1:p1', expect_terminal_id: 'term_aa01' };
  for (const [a, extra] of [['pane_run', { text: 'x' }], ['pane_send_text', { text: '1' }], ['pane_send_keys', { keys: ['enter'] }], ['pane_send_keys', { keys: ['y'] }]]) {
    const r = await req(c.port, 'POST', '/api/herdr/' + a, { body: wb({ ...shellOnly, ...extra }) });
    assert.equal(r.json.error.code, 'foreground_not_shell', a);
  }
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ ...shellOnly, keys: ['ctrl+c'] }) })).status, 200, 'ctrl+c can still stop a foreground program');
  c.herdr.state.fg['w1:p1'] = 'zsh';
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ ...shellOnly, keys: ['enter'] }) })).status, 200);
  // Origin: null is a clean refusal, not a 500
  assert.equal((await req(c.port, 'GET', '/api/inventory', { headers: { Origin: 'null' } })).status, 403);
  // error after the prompt was written, with wait => needs_review, never "failed"
  c.herdr.state.errorOn['agent.prompt'] = 'agent_not_running';
  const w = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text: 'wait for me', wait_timeout_ms: 5000 }) });
  assert.equal(w.json.status, 'needs_review');
  const nw = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ ...idle, text: 'no wait here' }) });
  assert.equal(nw.json.status, 'failed', 'without wait a definite refusal is a plain failure');
  c.herdr.state.errorOn = {};
  // a running server that differs from the proven version switches writes off
  c.herdr.state.serverVersion = '0.9.4';
  await req(c.port, 'POST', '/api/herdr/events_reconcile', { body: {} });
  const off = await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ ...shellOnly, keys: ['ctrl+c'] }) });
  assert.equal(off.status, 503); assert.match(off.json.error.message, /running server/);
  // unknown params must not slip through via inherited object keys
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ keys: ['ctrl+c'], constructor: 1 }) })).status, 400);
});

test('torn ledger tail does not swallow the next pending record', async () => {
  const dir = fs.mkdtempSync('/tmp/hp-led-');
  const file = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(file, '{"t":"pending","request_id":"torn","idempotency_key":"k-torn-xxxxxxxxxxxx","pay', { mode: 0o600 });
  const { Ledger } = require('../lib/ledger');
  const l = new Ledger(file);
  l.begin({ request_id: 'r1', idempotency_key: 'k-after-torn-xxxxxxx', payload_hash: 'h', action: 'a', session: 's', target: {}, started_at: 'now' });
  const l2 = new Ledger(file); // simulated restart after a crash before finish()
  assert.equal(l2.lookup('k-after-torn-xxxxxxx').record.status, 'needs_review');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- agent_decision + audit ----------------
const blockedPane = (c, over = {}) => { c.herdr.state.panes['w1:p4'] = { pane_id: 'w1:p4', terminal_id: 'term_aa04', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/ws', agent: 'claude', agent_status: 'blocked', focused: false, ...over }; };
const dialog = (c, over = {}) => { blockedPane(c); c.herdr.state.dialogs['w1:p4'] = { header: ['Accessing workspace:', '', '/tmp/ws', '', 'Quick safety check: do you trust this folder?'], options: ['No, exit', 'Yes, I trust this folder'], cursor: 0, numbered: false, afterEnter: 'clear', ...over }; };
const decide = (c, option, extra = {}) => req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', option, ...extra }) });
const keySends = (c) => c.herdr.calls.filter((x) => x.method === 'agent.send_keys').map((x) => x.params.keys);

test('agent_decision: moves the cursor, verifies it, then sends Enter once', async (t) => {
  const c = await setup(t, { decision: true });
  dialog(c);
  const r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.status, 200, r.text); assert.equal(r.json.status, 'input_sent');
  assert.deepEqual(keySends(c), [['down'], ['enter']], 'minimal keys: one move, then Enter');
  assert.equal(c.herdr.state.chosen['w1:p4'], 'Yes, I trust this folder');
  assert.deepEqual(r.json.detail.option, { index: 1, key: null, label: 'Yes, I trust this folder' });
  assert.equal(r.json.detail.dialog_cleared, true);
  // Enter is only sent after a fresh read that showed the highlight on the wanted option
  const seq = c.herdr.calls.map((x) => x.method + (x.method === 'agent.send_keys' ? ':' + x.params.keys.join('+') : ''));
  const enterAt = seq.indexOf('agent.send_keys:enter');
  assert.ok(seq.slice(seq.indexOf('agent.send_keys:down'), enterAt).includes('pane.read'), JSON.stringify(seq));
  // replay: same key never sends again; same key with another option is a conflict
  const again = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: { session: 'default', pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', option: 'Yes, I trust this folder', request_id: 'req-replay-0001', idempotency_key: r.json.idempotency_key } });
  assert.equal(again.json.replayed, true); assert.equal(keySends(c).length, 2);
  const conflict = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: { session: 'default', pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', option: 'No, exit', request_id: 'req-replay-0002', idempotency_key: r.json.idempotency_key } });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'idempotency_conflict');
});

test('agent_decision: cursor already on the option sends Enter only; numbered options match by key or label', async (t) => {
  const c = await setup(t, { decision: true });
  dialog(c);
  assert.equal((await decide(c, 'No, exit')).status, 200);
  assert.deepEqual(keySends(c), [['enter']]);
  dialog(c, { header: ['Do you want to proceed?'], options: ['Yes', 'Yes, and always allow', 'No'], numbered: true, cursor: 0 });
  c.herdr.calls.length = 0;
  const r = await decide(c, '3');
  assert.equal(r.status, 200, r.text); assert.deepEqual(keySends(c), [['down', 'down'], ['enter']]);
  assert.equal(c.herdr.state.chosen['w1:p4'], 'No');
  dialog(c, { header: ['Do you want to proceed?'], options: ['Yes', 'No'], numbered: true, cursor: 1 });
  assert.equal((await decide(c, '1. Yes')).status, 200); assert.equal(c.herdr.state.chosen['w1:p4'], 'Yes');
});

test('agent_decision: refuses anything that is not a recognised dialog on a blocked agent, sends nothing', async (t) => {
  const c = await setup(t, { decision: true });
  // not blocked
  const idle = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', option: 'Yes' }) });
  assert.equal(idle.status, 409); assert.equal(idle.json.error.code, 'not_blocked');
  const none = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ option: 'Yes' }) });
  assert.equal(none.json.error.code, 'no_agent');
  // blocked, but the screen is not a single-select list (fake codex pane prints "[y/n]")
  const free = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', option: 'y' }) });
  assert.equal(free.status, 422); assert.equal(free.json.error.code, 'dialog_not_recognized');
  dialog(c);
  const wrong = await decide(c, 'yes');
  assert.equal(wrong.status, 422); assert.equal(wrong.json.error.code, 'option_not_found');
  assert.deepEqual(wrong.json.error.dialog.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.equal((await decide(c, 'Yes, I trust this folder', { expect_terminal_id: 'term_ffff' })).json.error.code, 'target_changed');
  assert.equal((await decide(c, 'x', { keys: ['enter'] })).status, 400, 'unknown params rejected');
  assert.equal((await decide(c, '')).status, 400);
  assert.equal(c.herdr.writes().length, 0, 'nothing was sent');
  // other write actions still refuse the blocked pane, and now point at the option list
  const p = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', text: 'please continue' }) });
  assert.equal(p.json.error.code, 'blocked_requires_decision'); assert.equal(p.json.error.dialog.options.length, 2);
  const k = await req(c.port, 'POST', '/api/herdr/agent_send_keys', { body: wb({ pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', keys: ['enter'] }) });
  assert.equal(k.status, 400);
  assert.equal(c.herdr.writes().length, 0);
});

test('agent_decision refuse list: deletion, sudo, credentials, writes outside the workspace -> 403 escalate_to_owner', async (t) => {
  const c = await setup(t, { decision: true });
  const dangerous = [
    ['deletion', ['Bash command', '  rm -rf build/', 'Do you want to proceed?']],
    ['deletion', ['Bash command', '  git reset --hard HEAD~3', 'Do you want to proceed?']],
    ['deletion', ['Bash command', '  psql -c "DROP TABLE users"', 'Do you want to proceed?']],
    ['deletion', ['Delete the file src/a.js?']],
    ['sudo', ['Bash command', '  sudo launchctl unload x', 'Do you want to proceed?']],
    ['credentials', ['Enter your password to continue']],
    ['credentials', ['Read the file /tmp/ws/.env ?']],
    ['credentials', ['Send the API key to the server?']],
    ['overwrite_outside_workspace', ['Write to ~/notes/out.txt ?']],
    ['overwrite_outside_workspace', ['Edit file /etc/hosts ?']],
    ['overwrite_outside_workspace', ['Bash command', '  cp a.txt ../elsewhere/a.txt', 'Do you want to proceed?']],
    ['overwrite_outside_workspace', ['Bash command', '  echo hi > /Users/someone/file', 'Do you want to proceed?']],
  ];
  for (const [category, header] of dangerous) {
    for (const option of ['Yes', 'No']) { // even "No" is escalated: the whole dialog is the owner's
      dialog(c, { header, options: ['Yes', 'No'], numbered: true });
      const r = await decide(c, option);
      assert.equal(r.status, 403, header.join('|') + ' ' + r.text);
      assert.equal(r.json.error.code, 'escalate_to_owner'); assert.equal(r.json.error.reason, 'escalate_to_owner');
      assert.equal(r.json.error.category, category, header.join('|'));
    }
  }
  // the option label alone is enough
  dialog(c, { header: ['Do you want to proceed?'], options: ['Yes', 'Yes, and delete the cache'], numbered: true });
  assert.equal((await decide(c, 'Yes')).status, 403);
  assert.equal(c.herdr.writes().length, 0, 'nothing was sent for any refused dialog');
  // benign dialogs inside the workspace pass: no false positive on paths, urls, "edit", "confirm"
  dialog(c, { header: ['Edit file /tmp/ws/src/a.js ?', 'see https://example.com/docs/x and process.env.NODE_ENV', 'Confirm the edit'], options: ['Yes', 'No'], numbered: true });
  const ok = await decide(c, 'Yes');
  assert.equal(ok.status, 200, ok.text); assert.deepEqual(keySends(c), [['enter']]);
});

test('agent_decision refuses a dialog whose top is clipped off the viewport (a small pane hides the text the refuse list needs)', async (t) => {
  const c = await setup(t, { decision: true });
  dialog(c, { header: ['Bash command', '  rm -rf build/', 'Do you want to proceed?'], options: ['Yes', 'No'], numbered: true, viewportRows: 4 });
  const r = await decide(c, 'Yes');
  assert.equal(r.status, 422, r.text); assert.equal(r.json.error.code, 'dialog_incomplete'); assert.equal(r.json.error.dialog.complete, false);
  assert.equal(c.herdr.writes().length, 0);
  dialog(c, { viewportRows: 5 });
  assert.equal((await decide(c, 'Yes, I trust this folder')).json.error.code, 'dialog_incomplete', 'even for a harmless dialog: completeness cannot be judged');
  dialog(c); // same dialog, full screen: answered
  assert.equal((await decide(c, 'Yes, I trust this folder')).status, 200);
  // the window can also close between the first read and the re-check
  dialog(c); let reads = 0;
  c.herdr.state.onCall = (rq) => { if (rq.method === 'pane.read' && ++reads === 2) c.herdr.state.dialogs['w1:p4'].viewportRows = 4; };
  c.herdr.calls.length = 0;
  const late = await decide(c, 'Yes, I trust this folder');
  assert.equal(late.json.detail.error, 'dialog_changed'); assert.equal(c.herdr.writes().length, 0);
});

test('agent_decision re-checks right before sending: changed dialog, unblocked agent, highlight that never arrives, unverified outcome', async (t) => {
  const c = await setup(t, { decision: true });
  // 1. the screen changes between the first read and the pre-send re-check
  dialog(c);
  let reads = 0;
  c.herdr.state.onCall = (rq) => { if (rq.method === 'pane.read' && ++reads === 2) c.herdr.state.dialogs['w1:p4'].header = ['A different question appeared']; };
  let r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.status, 422); assert.equal(r.json.detail.error, 'dialog_changed'); assert.equal(r.json.detail.confirmed, false);
  assert.equal(c.herdr.writes().length, 0, 'no key sent');
  // 2. the agent stops being blocked in that window
  dialog(c); c.herdr.state.onCall = null; let gets = 0;
  c.herdr.state.onCall = (rq) => { if (rq.method === 'pane.get' && ++gets === 2) c.herdr.state.panes['w1:p4'].agent_status = 'working'; };
  r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.json.detail.error, 'no_longer_blocked'); assert.equal(c.herdr.writes().length, 0);
  // 3. the highlight never reaches the option: Enter must never be sent
  dialog(c, { ignoreMoves: true }); c.herdr.state.onCall = null;
  r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.json.detail.error, 'cursor_not_on_option'); assert.deepEqual(r.json.detail.keys_sent, ['down']);
  assert.ok(!keySends(c).some((k) => k.includes('enter')), 'Enter was never sent');
  // 4. Enter was sent but the same dialog is still on screen: uncertain, never "ok"
  dialog(c, { afterEnter: 'stay' });
  r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.status, 502); assert.equal(r.json.status, 'needs_review'); assert.equal(r.json.detail.error, 'outcome_unverified');
  // a failed attempt does not allow a silent re-send under the same key
  const again = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: { session: 'default', pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', option: 'Yes, I trust this folder', request_id: 'req-again-0001', idempotency_key: r.json.idempotency_key } });
  assert.equal(again.json.replayed, true); assert.equal(again.json.status, 'needs_review');
});

test('audit log: one durable line per manage action incl. refusals; audit_tail reads it; no prompt text; survives restart', async (t) => {
  const c = await setup(t, { decision: true });
  dialog(c);
  const okKey = 'idem-audit-' + crypto.randomUUID();
  assert.equal((await decide(c, 'Yes, I trust this folder', { idempotency_key: okKey, request_id: 'req-audit-ok-1' })).status, 200);
  dialog(c, { header: ['Bash command', '  rm -rf build/'], options: ['Yes', 'No'], numbered: true });
  assert.equal((await decide(c, 'Yes', { request_id: 'req-audit-403-1' })).status, 403);
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', text: 'SECRET-PROMPT-TEXT please' }) })).status, 200);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: 'echo SECRET-COMMAND-TEXT' }) })).status, 200);
  assert.equal((await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ text: '' }) })).status, 400);
  // reads are not audited
  await req(c.port, 'GET', '/api/herdr/agent_list?session=default');
  const tail = await req(c.port, 'GET', '/api/herdr/audit_tail?n=50');
  assert.equal(tail.status, 200, tail.text); assert.equal(tail.json.count, 5);
  const [dec, refused, prompt, run, bad] = tail.json.entries;
  assert.deepEqual([dec.action, dec.pane, dec.result, dec.http_status, dec.option.label], ['herdr.agent_decision', 'w1:p4', 'input_sent', 200, 'Yes, I trust this folder']);
  assert.equal(dec.request_id, 'req-audit-ok-1'); assert.equal(dec.idempotency_key, okKey);
  assert.deepEqual([refused.result, refused.http_status, refused.error_code, refused.category, refused.option.label], ['rejected', 403, 'escalate_to_owner', 'deletion', 'Yes']);
  assert.deepEqual([prompt.action, prompt.result], ['herdr.agent_prompt', 'input_sent']);
  assert.deepEqual([run.action, run.result, run.pane], ['herdr.pane_run', 'input_sent', 'w1:p1']);
  assert.deepEqual([bad.result, bad.http_status, bad.error_code], ['rejected', 400, 'invalid_param']);
  assert.ok(!tail.text.includes('SECRET-'), 'no prompt or command text in the audit log');
  for (const e of tail.json.entries) assert.match(e.timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.equal((await req(c.port, 'GET', '/api/herdr/audit_tail?n=1')).json.entries[0].error_code, 'invalid_param');
  for (const n of ['0', '501', 'x']) assert.equal((await req(c.port, 'GET', '/api/herdr/audit_tail?n=' + n)).status, 400, n);
  assert.equal((await req(c.port, 'GET', '/api/herdr/audit_tail', { token: null })).status, 401);
  assert.equal((await req(c.port, 'POST', '/api/herdr/audit_tail', { body: {} })).status, 405);
  const file = path.join(c.dir, 'logs', 'audit.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5);
  await c.restart();
  assert.equal((await req(c.port, 'GET', '/api/herdr/audit_tail?n=50')).json.count, 5, 'entries survive a restart');
});

test('dialog helpers: parser, fingerprint, refuse list', () => {
  const d = require('../lib/dialog');
  const screen = (cursor) => ['junk above', '❯ claude', '─'.repeat(40), ' Do you trust this?', '', ...['No', 'Yes'].map((o, i) => (i === cursor ? ' ❯ ' : '   ') + o), '', ' Enter to confirm · Esc to cancel'].join('\n');
  const a = d.parseDialog(screen(0)); const b = d.parseDialog(screen(1));
  assert.equal(a.hash, b.hash, 'moving the cursor does not change the fingerprint');
  assert.deepEqual([a.cursor, b.cursor], [0, 1]);
  assert.notEqual(a.hash, d.parseDialog(screen(0).replace('trust', 'delete')).hash);
  assert.equal(d.parseDialog('just a shell\n$ ls\n❯ claude\n'), null, 'a lone prompt line is not a list');
  assert.equal(d.parseDialog('Allow? [y/n]'), null);
  assert.deepEqual(d.movesTo(a, 1), ['down']); assert.deepEqual(d.movesTo(b, 0), ['up']); assert.deepEqual(d.movesTo(a, 0), []);
  assert.equal(d.refuseReason('Confirm the form', 'Yes', '/tmp/ws'), null, '"rm" inside a word is not deletion');
  assert.equal(d.refuseReason('Run npm test', 'Yes', '/tmp/ws'), null);
  assert.equal(d.refuseReason('Create /tmp/ws/new.txt', 'Yes', '/tmp/ws'), null, 'inside the workspace is fine (tmp symlink resolved)');
  assert.equal(d.refuseReason('Create /tmp/ws2/new.txt', 'Yes', '/tmp/ws').category, 'overwrite_outside_workspace', 'a sibling dir with the same prefix is outside');
  assert.equal(d.refuseReason('Create ../x/new.txt', 'Yes', '/tmp/ws').category, 'overwrite_outside_workspace');
  // keywords cut by a soft wrap are still found
  assert.equal(d.refuseReason('Bash command\n  sud\no launchctl list', 'Yes', '/tmp/ws').category, 'sudo');
  assert.equal(d.refuseReason('Run: git reset --ha\nrd HEAD', 'Yes', '/tmp/ws').category, 'deletion');
  assert.equal(d.refuseReason('Send pass\nword to host', 'Yes', '/tmp/ws').category, 'credentials');
});

// ---------------- reviewer findings (2026-10-13) ----------------
const R40 = '─'.repeat(40); const D40 = '╌'.repeat(40);
const screen = (cmd, opts, tail = [' Esc to cancel · Tab to amend']) => ['⏺ Bash', R40, ' Bash command', '', D40, ...cmd, D40, ' Do you want to proceed?', ...opts, ...tail].join('\n');
const OPTS = [' ❯ 1. Yes', '   2. No'];

test('dialog scan: a rule printed inside the command cannot hide the text above it', () => {
  const d = require('../lib/dialog');
  for (const cmd of [[' rm -rf ~/Documents', ' echo ' + R40], [' sudo rm -rf /', ' echo ' + R40, ' ls'], [' cp a /etc/x', ' echo ' + '━'.repeat(30)]]) {
    const p = d.parseDialog(screen(cmd, OPTS));
    assert.ok(p.framed); assert.ok(d.refuseReason(p.scan, 'Yes', '/tmp/ws'), cmd.join('|'));
  }
  const cmd = [' echo a', ' echo ' + R40];
  const a = d.parseDialog(screen(cmd, [' ❯ 1. Yes', '   2. No'])); const b = d.parseDialog(screen(cmd, ['   1. Yes', ' ❯ 2. No']));
  assert.deepEqual([a.cursor, b.cursor], [0, 1]); assert.equal(a.hash, b.hash, 'moving the cursor keeps the fingerprint');
  assert.notEqual(a.hash, d.parseDialog(screen([' echo b', ' echo ' + R40], [' ❯ 1. Yes', '   2. No'])).hash, 'a different command changes it');
});

test('refuse list: redirects, variables, ~user, dot-dot, quoting tricks, git destructive forms, truncation', () => {
  const d = require('../lib/dialog');
  const refused = ['echo hi >/etc/x', 'echo hi 2>/etc/x', 'cp a ${HOME}/.zshrc', 'cp a $OLDPWD/../b', 'echo hi > $TMPDIR/x', 'cp a ~root/x', 'cp a sub/../../../outside',
    'sed -i s/a/b/ /etc/hosts', 'curl -o /etc/hosts http://x', 'tar -C / -xf a.tar', 'install a /usr/local/bin/a', 'git clone x /opt/x',
    'git branch -D main', 'r""m -rf x', "r'm' -rf x", '\\rm -rf x', 'git checkout -- .', 'mv x /dev/null', 'git push origin main --force', 'git push -f origin main'];
  for (const c of refused) assert.ok(d.refuseReason('Bash command\n  ' + c, 'Yes', '/tmp/ws'), c);
  for (const c of ['npm test', 'cat src/a.js', 'echo hi > ./out.txt', 'node scripts/x.js --out=build/y.js', 'curl https://example.com/a/b', 'git status', 'git push origin main', 'ls /dev/null']) {
    assert.equal(d.refuseReason('Bash command\n  ' + c, 'Yes', '/tmp/ws'), null, c);
  }
  // a working directory that is the home directory is no workspace
  assert.ok(d.refuseReason('cp a ' + require('os').homedir() + '/x', 'Yes', require('os').homedir()));
  assert.ok(d.refuseReason('cp a /tmp/ws/x', 'Yes', null), 'unknown cwd fails closed');
  for (const t of ['… +12 lines (ctrl+o to expand)', 'ctrl+o to expand', 'output (truncated)']) assert.ok(d.looksTruncated(t), t);
  assert.ok(!d.looksTruncated('Do you want to proceed?'));
});

test('dialog parser: stale lists, prompts below, footer words in labels, prose with ">" and wrapped labels', () => {
  const d = require('../lib/dialog');
  // a stale list higher up with a real prompt below it is not a dialog
  assert.equal(d.parseDialog([R40, ' ❯ Dark', '   Light', '', 'filler', 'Delete ALL files in ~/Documents? (y/N)'].join('\n')), null);
  // quoted prose below a real dialog: the lowest cursor glyph is not a list
  assert.equal(d.parseDialog(screen([' echo a'], OPTS, [' Esc to cancel', '> quoted line', '  more quoted'])), null);
  // two cursor lists inside one frame (a second one printed above the options): ambiguous, refused
  assert.equal(d.parseDialog(screen([' echo a', ' ❯ fake option', '   other fake'], OPTS)), null);
  // a cursor option whose label contains footer words is still that option
  const f = d.parseDialog(screen([' echo a'], [' ❯ 1. Yes, and press Enter to confirm', '   2. No']));
  assert.deepEqual(f.options.map((o) => o.label), ['Yes, and press Enter to confirm', 'No']);
  // command text indented under a ">" line is not mistaken for options
  assert.equal(d.parseDialog([R40, '> run', '  echo a', '  echo b', '', 'Do you want to proceed?'].join('\n')), null);
  // wrapped labels stay attached to their option, later options are still listed
  const w = d.parseDialog(screen([' echo a'], [' ❯ 1. Yes', '   2. Yes, and always allow access to /a/very/long/path', '      from this project', '   3. No']));
  assert.deepEqual(w.options.map((o) => [o.key, o.label]), [['1', 'Yes'], ['2', 'Yes, and always allow access to /a/very/long/path from this project'], ['3', 'No']]);
  assert.deepEqual(d.movesTo(w, 2), ['down', 'down']);
});

test('agent_decision: truncated dialog refused; failed move restores the cursor; audit shape and multibyte tail', async (t) => {
  const c = await setup(t, { decision: true });
  dialog(c, { header: ['Bash command', '  ls', '… +40 lines (ctrl+o to expand)', 'Do you want to proceed?'], options: ['Yes', 'No'], numbered: true });
  let r = await decide(c, 'Yes');
  assert.equal(r.status, 422); assert.equal(r.json.error.code, 'dialog_incomplete'); assert.equal(c.herdr.writes().length, 0);
  // the highlight never arrives: Enter is never sent and the displaced cursor is put back with arrow keys
  dialog(c, { ignoreMoves: true });
  r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.json.detail.error, 'cursor_not_on_option'); assert.equal(r.json.detail.cursor_restored, true);
  assert.deepEqual(keySends(c), [['down'], ['up']]); assert.ok(!keySends(c).flat().includes('enter'));
  // audit: option has one shape everywhere; recovered entries are appended at boot
  const tail = await req(c.port, 'GET', '/api/herdr/audit_tail?n=10');
  for (const e of tail.json.entries) assert.ok(e.option === null || (typeof e.option === 'object' && 'label' in e.option), JSON.stringify(e));
  const { Audit } = require('../lib/audit');
  const f = path.join(c.dir, 'mb.jsonl'); const a = new Audit(f);
  const big = 'é'.repeat(300);
  for (let i = 0; i < 700; i++) a.append({ i, big }); // > 256 KiB: the window spans two chunks, boundaries fall inside multibyte characters
  const got = a.tail(500).entries;
  assert.equal(got.length, 500); assert.ok(got.every((e) => e.big === big), 'no replacement characters');
  fs.writeFileSync(path.join(c.dir, 'state', 'ledger.jsonl'), JSON.stringify({ t: 'pending', request_id: 'req-crash-0001', idempotency_key: 'idem-crash-0000000000001', payload_hash: 'h', action: 'herdr.agent_decision', session: 'default', target: { pane_id: 'w1:p4' }, started_at: 'x' }) + '\n', { flag: 'a' });
  await c.restart();
  const after = (await req(c.port, 'GET', '/api/herdr/audit_tail?n=50')).json.entries.find((e) => e.request_id === 'req-crash-0001');
  assert.deepEqual([after.result, after.error_code, after.recovered, after.pane], ['needs_review', 'portal_restarted_before_result_recorded', true, 'w1:p4']);
});

// ---------------- security repair: decision off by default, per-target write compatibility, forwarded parameters ----------------
test('agent_decision is off by default: refused before anything is read, recorded or sent, and nothing else can answer the dialog', async (t) => {
  const c = await setup(t); // no opt-in
  dialog(c);
  const body = { session: 'default', pane_id: 'w1:p4', expect_terminal_id: 'term_aa04', option: 'Yes, I trust this folder', request_id: 'req-off-0001', idempotency_key: 'idem-off-0000000001' };
  for (let i = 0; i < 2; i++) { // the same key twice: a refused request consumes nothing
    const r = await req(c.port, 'POST', '/api/herdr/agent_decision', { body });
    assert.equal(r.status, 404, r.text); assert.equal(r.json.error.code, 'action_disabled'); assert.match(r.json.error.message, /owner/);
  }
  assert.equal((await req(c.port, 'GET', '/api/herdr/agent_decision?session=default')).status, 405);
  assert.equal(c.herdr.writes().length, 0, 'no native input');
  assert.ok(!c.herdr.calls.some((x) => ['pane.get', 'pane.read', 'agent.send_keys', 'pane.send_keys'].includes(x.method)), 'the dialog was not even read');
  assert.equal(fs.readFileSync(path.join(c.dir, 'state', 'ledger.jsonl'), 'utf8'), '', 'no idempotency key was recorded');
  assert.equal((await req(c.port, 'GET', '/api/herdr/audit_tail?n=5')).json.count, 0);
  // no other action reaches the blocked dialog
  const blocked = { pane_id: 'w1:p4', expect_terminal_id: 'term_aa04' };
  for (const [a, extra] of [['agent_prompt', { text: 'please continue' }], ['agent_send_keys', { keys: ['esc'] }], ['pane_run', { text: 'y' }], ['pane_send_text', { text: '1' }], ['pane_send_keys', { keys: ['ctrl+c'] }]]) {
    const r = await req(c.port, 'POST', '/api/herdr/' + a, { body: wb({ ...blocked, ...extra }) });
    assert.equal(r.status, 409, a); assert.equal(r.json.error.code, 'blocked_requires_decision', a);
    assert.match(r.json.error.message, /Answer it in Herdr/);
  }
  assert.equal((await req(c.port, 'POST', '/api/herdr/agent_send_keys', { body: wb({ ...blocked, keys: ['enter'] }) })).status, 400, 'confirming keys are never accepted');
  assert.equal(c.herdr.writes().length, 0, 'still nothing sent');
});

test('agent_decision stays off for any opt-in value other than 1', async (t) => {
  const c = await setup(t, { decisionEnv: 'true' });
  dialog(c);
  const r = await decide(c, 'Yes, I trust this folder');
  assert.equal(r.status, 404); assert.equal(r.json.error.code, 'action_disabled');
  assert.equal(c.herdr.writes().length, 0);
});

test('every write re-checks its target session after taking the pane lock: wrong, missing or unreadable identity refuses before anything is sent', async (t) => {
  const c = await setup(t);
  const send = (text = 'x') => req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text }) });
  for (const [label, patch] of [['other version', { serverVersion: '0.9.4' }], ['other protocol', { protocol: 21 }], ['no version', { serverVersion: null }], ['no protocol', { protocol: null }]]) {
    Object.assign(c.herdr.state, { serverVersion: '0.9.3', protocol: 22 }, patch);
    const r = await send();
    assert.equal(r.status, 503, label); assert.equal(r.json.error.code, 'writes_disabled', label); assert.match(r.json.error.message, /nothing was sent/);
    assert.equal(c.herdr.writes().length, 0, label);
  }
  Object.assign(c.herdr.state, { serverVersion: '0.9.3', protocol: 22 });
  c.herdr.state.errorOn.ping = 'boom';
  const down = await send(); assert.equal(down.status, 502); assert.equal(c.herdr.writes().length, 0, 'an unreadable identity is not a green light');
  c.herdr.state.errorOn = {};
  assert.equal((await send()).status, 200, 'the same request goes through once the target is compatible');
  assert.equal(c.herdr.writes().length, 1);
  assert.equal(fs.readFileSync(path.join(c.dir, 'state', 'ledger.jsonl'), 'utf8').trim().split('\n').length, 2, 'only the one sent request was recorded (pending + result)');
});

test('a write that queued behind another on the same pane sees a compatibility change made in between', async (t) => {
  const c = await setup(t);
  c.herdr.state.onCall = (rq) => { if (rq.method === 'pane.send_text') c.herdr.state.serverVersion = '0.9.4'; }; // the server is replaced right after the first send
  const rs = await Promise.all([1, 2].map((i) => req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text: 'queued-' + i }) })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 503]);
  assert.equal(c.herdr.writes().length, 1, 'exactly one reached the pane');
  assert.equal(rs.find((r) => r.status === 503).json.error.code, 'writes_disabled');
});

test('one incompatible session does not switch writes off for the others', async (t) => {
  const c = await setup(t);
  const dir2 = fs.mkdtempSync('/tmp/hp-other-');
  const other = await fake.start(path.join(dir2, 'herdr.sock'));
  t.after(async () => { await other.close(); fs.rmSync(dir2, { recursive: true, force: true }); });
  other.state.serverVersion = '0.9.4';
  fs.writeFileSync(path.join(c.dir, 'extra-sessions.json'), JSON.stringify([{ name: 'other', dir: dir2 }]));
  await c.restart();
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await req(c.port, 'GET', '/api/inventory')).json.totals.sessions, 2);
  const ok = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text: 'to-default' }) });
  assert.equal(ok.status, 200, ok.text);
  const bad = await req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ session: 'other', text: 'to-other' }) });
  assert.equal(bad.status, 503); assert.match(bad.json.error.message, /session other/);
  assert.equal(other.writes().length, 0); assert.equal(c.herdr.writes().length, 1);
  assert.equal((await req(c.port, 'GET', '/api/health')).json.herdr.writes_enabled, true, 'the process-wide switch is unaffected by a session that is not targeted');
});

test('every forwarded Herdr parameter is declared in the action\'s proof (what gen-proof-matrix checks against the schema)', async (t) => {
  const { ACTIONS } = require('../lib/actions');
  const c = await setup(t);
  const S = { session: 'default' };
  const get = { // every optional parameter present, so the declared optional names are exercised too
    ping: S, session_snapshot: S, workspace_list: S, workspace_get: { ...S, workspace_id: 'w1' }, tab_list: { ...S, workspace_id: 'w1' }, tab_get: { ...S, tab_id: 'w1:t1' },
    pane_list: { ...S, workspace_id: 'w1' }, pane_get: { ...S, pane_id: 'w1:p1' }, agent_list: S, agent_get: { ...S, pane_id: 'w1:p2' },
    pane_read: { ...S, pane_id: 'w1:p1', source: 'visible', lines: '10' }, agent_wait: { ...S, pane_id: 'w1:p2', until: 'idle', timeout_ms: '1000' },
  };
  const post = {
    agent_start: wb({ pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', name: 'drift-check', kind: 'claude', startup_timeout_ms: 5000 }),
    agent_prompt: wb({ pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', text: 'hello there', wait_timeout_ms: 1000 }),
    agent_send_keys: wb({ pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', keys: ['esc'] }),
    pane_send_text: wb({ text: 'x' }), pane_send_keys: wb({ keys: ['ctrl+u'] }),
  };
  const seen = new Set();
  for (const [short, a] of Object.entries(ACTIONS).map(([n, v]) => [n.replace('herdr.', ''), v])) {
    if (!a.proof.sock || short === 'agent_decision') continue;
    c.herdr.calls.length = 0;
    if (get[short]) await req(c.port, 'GET', `/api/herdr/${short}?` + new URLSearchParams(get[short]));
    else { assert.ok(post[short], 'drift test has no request for ' + short); await req(c.port, 'POST', '/api/herdr/' + short, { body: post[short] }); }
    const sent = c.herdr.calls.filter((x) => x.method === a.proof.sock).pop();
    assert.ok(sent, short + ' did not call ' + a.proof.sock);
    const keys = Object.keys(sent.params || {}); const fw = a.proof.forwards;
    assert.ok(fw, short + ' declares no forwards');
    for (const k of keys) assert.ok([...fw.required, ...(fw.optional || [])].includes(k), `${short} sends undeclared parameter ${k}`);
    for (const k of fw.required) assert.ok(keys.includes(k), `${short} declares ${k} as always sent, but it was not`);
    for (const k of fw.optional || []) assert.ok(keys.includes(k), `${short} declares ${k}, but it was not sent when supplied`);
    seen.add(short);
  }
  assert.ok(seen.size >= 17, 'covered ' + seen.size);
  assert.deepEqual(ACTIONS['herdr.agent_decision'].proof.forwards, ACTIONS['herdr.agent_send_keys'].proof.forwards, 'the decision action sends keys exactly like agent_send_keys');
});

// ---- contract gate: any Herdr version is accepted while its schema still fits what each action sends ----
const put = (c, name, v) => fs.writeFileSync(path.join(c.dir, name), typeof v === 'string' ? v : JSON.stringify(v));
const sendText = (c, extra = {}) => req(c.port, 'POST', '/api/herdr/pane_send_text', { body: wb({ text: 'x', ...extra }) });
const sendKeys = (c) => req(c.port, 'POST', '/api/herdr/pane_send_keys', { body: wb({ keys: ['ctrl+c'] }) });
const health = async (c) => (await req(c.port, 'GET', '/api/health')).json.herdr;

test('a Herdr version nobody tested is accepted for writes while its schema still fits, and health says it is not the proven one', async (t) => {
  const c = await setup(t, { version: '0.9.9' });
  c.herdr.state.serverVersion = '0.9.9';
  const r = await sendText(c);
  assert.equal(r.status, 200, r.text); assert.equal(c.herdr.writes().length, 1);
  const h = await health(c);
  assert.equal(h.writes_enabled, true); assert.equal(h.installed_version, '0.9.9');
  assert.equal(h.contract.verified_live, false); assert.equal(h.contract.verified_version, '0.9.3'); assert.deepEqual(h.contract.failing_actions, []);
});

test('a schema that stopped matching one action refuses that action only, with contract_mismatch and nothing sent', async (t) => {
  const c = await setup(t);
  put(c, 'schema-patch.json', { dropField: { 'pane.send_text': 'text' } });
  await c.restart();
  const bad = await sendText(c);
  assert.equal(bad.status, 503); assert.equal(bad.json.error.code, 'contract_mismatch'); assert.match(bad.json.error.message, /pane\.send_text no longer accepts: text.*nothing was sent/);
  assert.equal(c.herdr.writes().length, 0);
  assert.equal((await sendKeys(c)).status, 200, 'an unaffected action still works');
  assert.equal((await req(c.port, 'GET', '/api/herdr/agent_list?session=default')).status, 200, 'reads are not gated');
  const h = await health(c);
  assert.equal(h.writes_enabled, true); assert.deepEqual(h.contract.failing_actions.map((f) => f.action), ['herdr.pane_send_text']);
});

test('a new required field, a removed method and a removed CLI subcommand are each refused', async (t) => {
  const c = await setup(t);
  put(c, 'schema-patch.json', { addRequired: { 'pane.send_keys': 'mode' } });
  await c.restart();
  const a = await sendKeys(c);
  assert.equal(a.json.error.code, 'contract_mismatch'); assert.match(a.json.error.message, /now requires: mode/);
  put(c, 'schema-patch.json', { drop: ['pane.process_info'] });
  put(c, 'version.txt', '0.9.4'); c.herdr.state.serverVersion = '0.9.4'; // a CLI upgrade is noticed without a restart
  const b = await sendText(c);
  assert.equal(b.json.error.code, 'contract_mismatch'); assert.match(b.json.error.message, /pane\.process_info is not in this Herdr's schema/, 'a method every write preflight needs');
  put(c, 'schema-patch.json', {}); put(c, 'no-pane-run.txt', '1'); put(c, 'version.txt', '0.9.5'); c.herdr.state.serverVersion = '0.9.5';
  const run = await req(c.port, 'POST', '/api/herdr/pane_run', { body: wb({ pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', text: 'ls' }) });
  assert.equal(run.json.error.code, 'contract_mismatch'); assert.match(run.json.error.message, /herdr pane run. is not available/);
  assert.equal(c.herdr.writes().length, 0);
});

test('upgrading the CLI and the server needs no portal restart; a server that did not follow is refused until it does', async (t) => {
  const c = await setup(t);
  assert.equal((await sendText(c)).status, 200);
  put(c, 'version.txt', '0.9.4'); // CLI upgraded; the running server is still 0.9.3
  const stale = await sendText(c);
  assert.equal(stale.status, 503); assert.equal(stale.json.error.code, 'writes_disabled'); assert.match(stale.json.error.message, /restart that Herdr server/);
  c.herdr.state.serverVersion = '0.9.4'; // the server restarted on the new build
  assert.equal((await sendText(c)).status, 200);
  assert.equal((await health(c)).installed_version, '0.9.4');
  assert.equal(c.herdr.writes().length, 2);
});

test('a protocol change on either side refuses writes; both sides on the new protocol is accepted', async (t) => {
  const c = await setup(t);
  c.herdr.state.protocol = 23; // the server speaks 23, the CLI schema still says 22
  assert.equal((await sendText(c)).json.error.code, 'writes_disabled');
  put(c, 'protocol.txt', '23'); put(c, 'version.txt', '0.9.4'); c.herdr.state.serverVersion = '0.9.4';
  assert.equal((await sendText(c)).status, 200);
  assert.equal(c.herdr.writes().length, 1);
});

test('an unreadable CLI schema switches writes off and the next write recovers once it is readable', async (t) => {
  const c = await setup(t);
  put(c, 'no-schema.txt', '1'); put(c, 'version.txt', '0.9.4'); c.herdr.state.serverVersion = '0.9.4';
  const off = await sendText(c);
  assert.equal(off.status, 503); assert.equal(off.json.error.code, 'writes_disabled'); assert.equal(c.herdr.writes().length, 0);
  assert.equal((await health(c)).writes_enabled, false);
  fs.rmSync(path.join(c.dir, 'no-schema.txt'));
  assert.equal((await sendText(c)).status, 200);
  assert.equal((await health(c)).writes_enabled, true);
});

test('HERDR_PORTAL_STRICT_VERSION=1 limits writes to the version proven live', async (t) => {
  const c = await setup(t, { version: '0.9.4', strict: true });
  c.herdr.state.serverVersion = '0.9.4';
  const r = await sendText(c);
  assert.equal(r.status, 503); assert.equal(r.json.error.code, 'writes_disabled'); assert.match(r.json.error.message, /STRICT_VERSION/);
  assert.equal(c.herdr.writes().length, 0);
  const ok = await setup(t, { strict: true });
  assert.equal((await sendText(ok)).status, 200, 'the proven version still works in strict mode');
});

test('the gate also covers agent_decision (its own method and the pane calls it makes) and optional parameters that became required', async (t) => {
  const c = await setup(t, { decision: true });
  put(c, 'schema-patch.json', { drop: ['pane.read'] });
  await c.restart();
  const dec = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', option: 'Yes' }) });
  assert.equal(dec.status, 503); assert.equal(dec.json.error.code, 'contract_mismatch'); assert.match(dec.json.error.message, /pane\.read is not in this Herdr's schema/);
  put(c, 'schema-patch.json', { addRequired: { 'agent.prompt': 'wait' } }); // `wait` is optional for the portal, so a schema that requires it no longer fits
  put(c, 'version.txt', '0.9.4'); c.herdr.state.serverVersion = '0.9.4';
  const pr = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: wb({ pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', text: 'hello' }) });
  assert.equal(pr.json.error.code, 'contract_mismatch'); assert.match(pr.json.error.message, /agent\.prompt now requires: wait/);
  assert.equal(c.herdr.writes().length, 0);
});
