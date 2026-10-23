'use strict';
// The plugin as Herdr installs it: a manifest that names real scripts, scripts that refuse to run outside Herdr, a client that can call
// only the methods it is allowed, and a screen that reads the real log.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const herdr = require('../plugin/lib/herdr');
const names = require('../plugin/lib/names');
const tag = require('../lib/tag');

const PLUGIN = path.join(__dirname, '..', 'plugin');
const manifest = fs.readFileSync(path.join(PLUGIN, 'herdr-plugin.toml'), 'utf8');
const field = (name) => (new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(manifest) || [])[1];
const commands = [...manifest.matchAll(/^command\s*=\s*\[([^\]]*)\]/gm)].map((m) => [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
const run = (script, args = [], env = {}) => spawnSync(process.execPath, [path.join(PLUGIN, 'bin', script), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
const sources = () => {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|toml)$/.test(e.name)) out.push(p); } })(PLUGIN);
  return out;
};

test('the manifest has the fields Herdr requires, and the id is one it accepts', () => {
  for (const f of ['id', 'name', 'version', 'min_herdr_version']) assert.ok(field(f), f);
  assert.match(field('id'), /^[A-Za-z0-9.:_-]+$/);
  assert.match(field('version'), /^\d+\.\d+\.\d+$/);
  assert.match(manifest, /^platforms\s*=\s*\["macos", "linux"\]/m);
});

test('every command in the manifest is node plus a script that exists, with no shell in between', () => {
  assert.equal(commands.length, 4);
  for (const c of commands) {
    assert.equal(c[0], 'node');
    assert.ok(fs.existsSync(path.join(PLUGIN, c[1])), c.join(' '));
    assert.doesNotMatch(c.join(' '), /\bsh\b|bash|-c\b/);
  }
});

test('there is no startup hook: Herdr documents those as one-shot, not as places to keep a process', () => {
  assert.doesNotMatch(manifest, /\[\[startup\]\]|\[\[events\]\]/);
});

test('action and pane ids are local ids: letters, digits, colon, underscore, hyphen, no dots', () => {
  const ids = [...manifest.matchAll(/^id\s*=\s*"([^"]*)"/gm)].map((m) => m[1]).slice(1);
  assert.equal(ids.length, 4);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9:_-]+$/, id);
});

test('the activity action opens the pane entrypoint the manifest declares, as a tab', () => {
  assert.match(manifest, /\[\[panes\]\]\s+id = "activity"\s+title = "[^"]*"\s+placement = "tab"/);
  const src = fs.readFileSync(path.join(PLUGIN, 'bin', 'open-activity.js'), 'utf8');
  assert.match(src, /entrypoint: 'activity', placement: 'tab'/);
});

test('scripts that need Herdr say so and exit 1 when run by hand', () => {
  assert.equal(run('open-activity.js').status, 1);
  assert.match(run('open-activity.js').stderr, /HERDR_SOCKET_PATH/);
  assert.equal(run('view.js', ['set']).status, 1);
  assert.equal(run('view.js', ['bogus'], { HERDR_SOCKET_PATH: '/x', HERDR_PLUGIN_ID: 'p' }).status, 1);
});

test('the sidebar token is the one the portal reports', () => {
  assert.equal(names.TOKEN, tag.TOKEN);
});

test('the client calls three methods and refuses every other before it connects', async () => {
  assert.deepEqual([...herdr.ALLOWED].sort(), ['agent.view.clear', 'agent.view.set', 'plugin.pane.open']);
  for (const m of ['pane.send_text', 'pane.send_keys', 'agent.prompt', 'pane.close', 'server.stop', 'workspace.close', 'ping']) {
    await assert.rejects(herdr.call('/nonexistent/herdr.sock', m, {}), (e) => e.code === 'method_not_allowed', m);
  }
});

test('the client sends an allowed method as one JSON line and returns the result or the error code', async () => {
  const dir = fs.mkdtempSync('/tmp/hpc-'); const sock = path.join(dir, 's.sock'); const seen = [];
  const server = net.createServer((c) => { c.setEncoding('utf8'); c.on('data', (d) => { const req = JSON.parse(d); seen.push(req); c.write(JSON.stringify(req.params.fail ? { id: req.id, error: { code: 'ui_busy', message: 'busy' } } : { id: req.id, result: { type: 'agent_view', active: true } }) + '\n'); }); });
  await new Promise((r) => server.listen(sock, r));
  try {
    assert.deepEqual(await herdr.call(sock, 'agent.view.clear', { source: 'plugin:x' }), { type: 'agent_view', active: true });
    assert.deepEqual(seen[0].params, { source: 'plugin:x' });
    await assert.rejects(herdr.call(sock, 'plugin.pane.open', { fail: true }), (e) => e.code === 'ui_busy');
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the plugin has no way to type into a pane, start an agent, run a program or stop Herdr', () => {
  const files = sources();
  assert.ok(files.length >= 7);
  const banned = /send_text|send_keys|send_input|agent\.prompt|agent\.start|pane\.run|pane\.close|workspace\.close|server\.stop|child_process|\bexec(Sync|File|FileSync)?\(|\bspawn(Sync)?\(|HERDR_BIN_PATH/;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), banned, path.relative(PLUGIN, f));
});

test('activity --once prints the newest entries of the portal log, plain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-act-'));
  const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ timestamp: '2026-10-23T05:05:47.062Z', action: 'herdr.agent_prompt', session: 'default', pane: 'w1:p' + i, result: i % 2 ? 'input_sent' : 'rejected', http_status: i % 2 ? 200 : 409, error_code: i % 2 ? null : 'dialog_on_screen', request_id: 'r' + i }));
  fs.writeFileSync(path.join(dir, 'audit.jsonl'), lines.join('\n') + '\nnot json\n');
  const r = run('activity.js', ['--once', '--lines', '5'], { HERDR_PORTAL_LOG_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n');
  assert.equal(rows.length, 5);
  assert.match(rows[4], /prompt +w1:p29 +sent$/);
  assert.match(rows[3], /prompt +w1:p28 +refused 409 dialog_on_screen$/);
  assert.doesNotMatch(r.stdout, /\x1b/);
});

test('activity --once on a missing log prints nothing and succeeds', () => {
  const r = run('activity.js', ['--once'], { HERDR_PORTAL_LOG_DIR: path.join(os.tmpdir(), 'hp-none-' + process.pid) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
