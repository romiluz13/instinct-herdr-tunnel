'use strict';
// Behavior of the pieces around the server: configuration defaults, the launchd plist printer, the shipped scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const runAsync = (args, env) => new Promise((resolve) => { // spawnSync would freeze the in-process fake Herdr and starve the portal's socket calls
  const c = require('node:child_process').spawn(process.execPath, args, { cwd: ROOT, env }); let stdout = ''; let stderr = '';
  c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d)); c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('config: defaults carry no machine-specific paths and every location can be overridden by environment', () => {
  const show = (env) => JSON.parse(execFileSync(process.execPath, ['-e', 'const c=require("./lib/config").config;console.log(JSON.stringify({bin:c.herdrBin,state:c.stateDir,log:c.logDir,port:c.port,host:c.host}))'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: '/home/someone', ...env }, encoding: 'utf8' }));
  const d = show({});
  assert.equal(d.bin, 'herdr', 'the Herdr binary is looked up on PATH unless HERDR_BIN says otherwise');
  assert.ok(d.state.startsWith('/home/someone/') && d.log.startsWith('/home/someone/'), 'state and logs live under the user home');
  assert.equal(d.host, '127.0.0.1');
  const o = show({ HERDR_BIN: '/opt/h/herdr', HERDR_PORTAL_STATE_DIR: '/srv/s', HERDR_PORTAL_LOG_DIR: '/srv/l', HERDR_PORTAL_PORT: '9911' });
  assert.deepEqual([o.bin, o.state, o.log, o.port], ['/opt/h/herdr', '/srv/s', '/srv/l', 9911]);
});

test('config: a timeout that is not a whole number of milliseconds falls back to its default instead of failing every call', () => {
  const show = (v) => JSON.parse(execFileSync(process.execPath, ['-e', 'const c=require("./lib/config").config;console.log(JSON.stringify([c.sizeToolTimeoutMs,c.controllerLifetimeMs,c.controllerKillGraceMs,c.historyTimeoutMs]))'],
    { cwd: ROOT, env: { PATH: process.env.PATH, HOME: '/home/someone', HERDR_PORTAL_SIZE_TOOL_TIMEOUT_MS: v, HERDR_PORTAL_CONTROLLER_LIFETIME_MS: v, HERDR_PORTAL_CONTROLLER_KILL_GRACE_MS: v, HERDR_PORTAL_HISTORY_TIMEOUT_MS: v }, encoding: 'utf8' }));
  for (const bad of ['1.5', '-5', 'Infinity', 'abc', '0', '', '3000000000']) assert.deepEqual(show(bad), [3000, 5000, 1000, 30000], JSON.stringify(bad));
  assert.deepEqual(show('250'), [250, 250, 250, 250]);
});

test('portalctl plist: prints the LaunchAgent definition without installing anything; label prefix and paths come from the environment', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ctl-'));
  const env = { HOME: home, HERDR_PORTAL_STATE_DIR: path.join(home, 'st'), HERDR_PORTAL_LOG_DIR: path.join(home, 'lg'), HERDR_BIN: '/opt/h/herdr', CLOUDFLARED_BIN: '/opt/c/cloudflared' };
  try {
    const p = run(['bin/portalctl', 'plist', 'portal'], env);
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stdout, /<key>Label<\/key><string>dev\.herdr-portal<\/string>/, 'neutral default label');
    assert.match(p.stdout, /<key>HERDR_BIN<\/key><string>\/opt\/h\/herdr<\/string>/);
    assert.match(p.stdout, /<key>HERDR_PORTAL_STATE_DIR<\/key><string>[^<]*\/st<\/string>/, 'a non-default state dir must reach the service');
    assert.match(p.stdout, /<key>CLOUDFLARED_BIN<\/key><string>\/opt\/c\/cloudflared<\/string>/);
    assert.ok(p.stdout.includes(path.join(ROOT, 'server.js')));
    assert.ok(!p.stdout.includes('ENABLE_AGENT_DECISION'), 'agent_decision stays off in the service unless the installer opted in');
    const on = run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_ENABLE_AGENT_DECISION: '1' });
    assert.match(on.stdout, /<key>HERDR_PORTAL_ENABLE_AGENT_DECISION<\/key><string>1<\/string>/, 'an explicit opt-in reaches the portal service');
    assert.ok(!run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_ENABLE_AGENT_DECISION: 'true' }).stdout.includes('ENABLE_AGENT_DECISION'), 'only "1" counts');
    assert.ok(!run(['bin/portalctl', 'plist', 'tunnel'], { ...env, HERDR_PORTAL_ENABLE_AGENT_DECISION: '1' }).stdout.includes('ENABLE_AGENT_DECISION'), 'the tunnel service never gets it');
    assert.ok(!p.stdout.includes('STRICT_VERSION'), 'strict version stays off in the service by default');
    for (const name of ['HISTORY', 'CONTROL', 'AGENT_CLICK']) assert.ok(!p.stdout.includes('ENABLE_' + name), name + ' stays off in the service unless the installer opted in');
    const sw = run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_ENABLE_HISTORY: 'all', HERDR_PORTAL_ENABLE_CONTROL: '1', HERDR_PORTAL_ENABLE_AGENT_CLICK: '1' }).stdout;
    assert.match(sw, /<key>HERDR_PORTAL_ENABLE_HISTORY<\/key><string>all<\/string>/); assert.match(sw, /<key>HERDR_PORTAL_ENABLE_CONTROL<\/key><string>1<\/string>/); assert.match(sw, /<key>HERDR_PORTAL_ENABLE_AGENT_CLICK<\/key><string>1<\/string>/);
    const typo = run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_ENABLE_HISTORY: 'yes', HERDR_PORTAL_ENABLE_CONTROL: 'true', HERDR_PORTAL_ENABLE_AGENT_CLICK: '2' }).stdout;
    assert.ok(!typo.includes('ENABLE_HISTORY') && !typo.includes('ENABLE_CONTROL') && !typo.includes('ENABLE_AGENT_CLICK'), 'a value the portal would not understand never reaches the service');
    assert.match(run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_ENABLE_HISTORY: 'agents' }).stdout, /<key>HERDR_PORTAL_ENABLE_HISTORY<\/key><string>agents<\/string>/);
    assert.ok(!/ENABLE_(HISTORY|CONTROL|AGENT_CLICK)/.test(run(['bin/portalctl', 'plist', 'tunnel'], { ...env, HERDR_PORTAL_ENABLE_HISTORY: 'all', HERDR_PORTAL_ENABLE_CONTROL: '1', HERDR_PORTAL_ENABLE_AGENT_CLICK: '1' }).stdout), 'the tunnel service never gets them');
    assert.match(run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_STRICT_VERSION: '1' }).stdout, /<key>HERDR_PORTAL_STRICT_VERSION<\/key><string>1<\/string>/, 'strict mode chosen at install reaches the portal service');
    assert.ok(!run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_STRICT_VERSION: 'yes' }).stdout.includes('STRICT_VERSION'), 'only "1" counts for strict');
    assert.ok(!run(['bin/portalctl', 'plist', 'tunnel'], { ...env, HERDR_PORTAL_STRICT_VERSION: '1' }).stdout.includes('STRICT_VERSION'), 'the tunnel service never gets strict');
    const t = run(['bin/portalctl', 'plist', 'tunnel'], { ...env, HERDR_PORTAL_LAUNCHD_PREFIX: 'org.example.hp' });
    assert.match(t.stdout, /<key>Label<\/key><string>org\.example\.hp\.tunnel<\/string>/);
    assert.ok(t.stdout.includes(path.join(ROOT, 'bin', 'tunnel-runner.js')));
    assert.notEqual(run(['bin/portalctl', 'plist', 'portal'], { ...env, HERDR_PORTAL_LAUNCHD_PREFIX: 'bad</string><x>' }).status, 0, 'a prefix that could break the XML is refused');
    assert.notEqual(run(['bin/portalctl', 'plist', 'nope'], env).status, 0);
    assert.deepEqual(fs.readdirSync(home).sort(), [], 'printing created no token, directory or LaunchAgent file');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('tunnel-runner: finds cloudflared on PATH by default and records the Quick Tunnel URL it announces', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-tun-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'cloudflared'), '#!/bin/sh\necho "INF |  https://fake-name-example.trycloudflare.com  |"\nexec sleep 20\n', { mode: 0o755 });
  const state = path.join(dir, 'st');
  const child = require('node:child_process').spawn(process.execPath, ['bin/tunnel-runner.js'], { cwd: ROOT, env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, HERDR_PORTAL_STATE_DIR: state, HERDR_PORTAL_LOG_DIR: path.join(dir, 'lg') }, stdio: 'ignore' });
  try {
    const file = path.join(state, 'tunnel-url.txt');
    for (let i = 0; i < 50 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readFileSync(file, 'utf8').trim(), 'https://fake-name-example.trycloudflare.com');
  } finally { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 300)); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the shipped scripts against a portal that runs on the test fake (no real Herdr, no real panes) ----
const crypto = require('node:crypto');
const fake = require('./fixtures/fake-herdr-server');

async function portalOnFake(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-scr-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(path.join(state, 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(state, 'secrets', 'portal-token'), crypto.randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });
  const herdr = await fake.start(path.join(dir, 'herdr.sock'));
  const wrapper = path.join(dir, 'herdr');
  fs.writeFileSync(wrapper, `#!/bin/sh\nFAKE_HERDR_DIR='${dir}' exec '${process.execPath}' '${path.join(__dirname, 'fixtures', 'fake-herdr-cli.js')}' "$@"\n`, { mode: 0o755 });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { PATH: process.env.PATH, HOME: dir, HERDR_PORTAL_STATE_DIR: state, HERDR_PORTAL_LOG_DIR: path.join(dir, 'logs'), HERDR_PORTAL_PORT: String(port), HERDR_BIN: wrapper };
  const child = require('node:child_process').spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !out.includes('"listening"'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('"listening"'), out);
  await new Promise((r) => setTimeout(r, 600));
  t.after(async () => { child.kill('SIGTERM'); await herdr.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, env, base: `http://127.0.0.1:${port}` };
}

test('scripts/e2e.js: the read-only proof passes against a portal, finding the token through the configured state directory', async (t) => {
  const p = await portalOnFake(t);
  const r = await runAsync(['scripts/e2e.js', '--base', p.base, '--out', path.join(p.dir, 'e2e.json')], p.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL PASS/);
  const rec = JSON.parse(fs.readFileSync(path.join(p.dir, 'e2e.json'), 'utf8'));
  assert.ok(rec.steps.length >= 12 && rec.steps.every((s) => s.ok));
  assert.ok(!JSON.stringify(rec).includes(fs.readFileSync(path.join(p.env.HERDR_PORTAL_STATE_DIR, 'secrets', 'portal-token'), 'utf8').trim()), 'the token is not written to the proof file');
});

test('scripts/smoke-actions.js and decision-proof.js read the token from the configured state directory', async (t) => {
  const p = await portalOnFake(t);
  const s = await runAsync(['scripts/smoke-actions.js', '--base', p.base, '--out', path.join(p.dir, 'smoke.json')], p.env);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(p.dir, 'smoke.json'), 'utf8'));
  assert.equal(saved.results['herdr.ping'].ok, true, 'authenticated calls worked');
  assert.equal(saved.base, undefined, 'the address is not saved');
  for (const [name, r] of Object.entries(saved.results)) assert.deepEqual(Object.keys(r).sort(), ['at', 'ok'], name + ': a receipt keeps pass/fail and a time, never notes');
  assert.match(saved.identity.source_sha256, /^[0-9a-f]{64}$/); assert.equal(saved.identity.herdr_version, '0.9.5'); assert.equal(saved.identity.protocol, 22);
  assert.ok(!JSON.stringify(saved).includes('127.0.0.1') && !JSON.stringify(saved).includes(p.dir), 'no address or path in the receipt');
  const d = await runAsync(['scripts/decision-proof.js', '--base', p.base], p.env);
  assert.equal(d.status, 2); assert.match(d.stderr, /missing --refuse-pane/);
});

// A proxy in front of a fake-backed portal that breaks exactly one path, so a smoke failure is real HTTP, not a stub script.
async function breakingProxy(t, base, brokenPath, reply) {
  const server = require('node:http').createServer(async (req, res) => {
    if (req.url.split('?')[0] === brokenPath) { res.writeHead(reply.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(reply.body)); }
    let body = ''; for await (const c of req) body += c;
    const r = await fetch(base + req.url, { method: req.method, headers: { Authorization: req.headers.authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined });
    res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(await r.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('scripts/smoke-actions.js: a failed check exits 1 and still writes its receipt naming the failure', async (t) => {
  const p = await portalOnFake(t);
  const base = await breakingProxy(t, p.base, '/api/herdr/tab_list', { status: 500, body: { ok: false, error: { code: 'internal' } } });
  const out = path.join(p.dir, 'smoke.json');
  const s = await runAsync(['scripts/smoke-actions.js', '--base', base, '--out', out], p.env);
  assert.equal(s.status, 1, s.stdout + s.stderr);
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.results['herdr.tab_list'].ok, false);
  assert.deepEqual(saved.summary.failed, ['herdr.tab_list']);
  assert.equal(saved.summary.incomplete, undefined);
});

test('scripts/smoke-actions.js: a run that crashes part-way exits 1 with a receipt marked incomplete', async (t) => {
  const p = await portalOnFake(t);
  const base = await breakingProxy(t, p.base, '/api/herdr/agent_list', { status: 500, body: { ok: false } });
  const out = path.join(p.dir, 'smoke.json');
  const s = await runAsync(['scripts/smoke-actions.js', '--base', base, '--out', out], p.env);
  assert.equal(s.status, 1, s.stdout + s.stderr);
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(saved.summary.incomplete, true);
  assert.equal(saved.results['herdr.ping'].ok, true, 'checks before the crash are kept');
  assert.ok(!JSON.stringify(saved).includes(p.dir), 'no path in the receipt');
});

test('scripts/smoke-actions.js: an all-pass read run exits 0 and names the skipped writes as unexercised, not passed', async (t) => {
  const p = await portalOnFake(t);
  const out = path.join(p.dir, 'smoke.json');
  const s = await runAsync(['scripts/smoke-actions.js', '--base', p.base, '--out', out], p.env);
  assert.equal(s.status, 0, s.stdout + s.stderr);
  const skipped = ['herdr.pane_send_text', 'herdr.pane_send_keys', 'herdr.pane_run', 'herdr.agent_start', 'herdr.agent_send_keys', 'herdr.agent_prompt'];
  const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(saved.summary, { failed: [], unexercised: skipped });
  for (const a of skipped) assert.equal(saved.results[a], undefined, `${a} has no result row`);
  assert.match(s.stdout, /UNEXERCISED \(not evidence\): herdr\.pane_send_text/);
});

test('scripts/decision-proof.js no longer answers a folder-trust dialog: the old scenario is refused before the token is read or any request is made', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-dp-'));
  try {
    // no token file exists in this state directory and nothing listens on the base address: reaching either would fail differently
    const r = run(['scripts/decision-proof.js', '--accept-pane', 'w1:p1', '--accept-term', 'term_x', '--base', 'http://127.0.0.1:9'], { HOME: home, HERDR_PORTAL_STATE_DIR: path.join(home, 'st') });
    assert.equal(r.status, 2); assert.match(r.stderr, /refused: --accept-pane/); assert.ok(!/ENOENT|ECONNREFUSED|fetch/.test(r.stderr), r.stderr);
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'decision-proof.js'), 'utf8');
    assert.ok(!/trust this folder|Quick safety check/.test(src), 'the trust-grant scenario is gone from the script');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('scripts/e2e.js receipts carry the identity but neither the base address nor the socket path', async (t) => {
  const p = await portalOnFake(t);
  const r = await runAsync(['scripts/e2e.js', '--base', p.base, '--out', path.join(p.dir, 'e2e2.json')], p.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(fs.readFileSync(path.join(p.dir, 'e2e2.json'), 'utf8'));
  assert.equal(rec.base, undefined); assert.match(rec.identity.source_sha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(rec).includes('herdr.sock'), 'no socket path');
});

test('scripts/put-file-proof.js passes against a portal, cleans up after itself and prints neither the token nor the address', async (t) => {
  const p = await portalOnFake(t);
  const r = await runAsync(['scripts/put-file-proof.js', '--base', p.base], p.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL PASSED/); assert.ok(!/FAIL /.test(r.stdout));
  assert.ok(!r.stdout.includes(p.base) && !r.stdout.includes(fs.readFileSync(path.join(p.dir, 'state', 'secrets', 'portal-token'), 'utf8').trim()));
  assert.deepEqual(fs.readdirSync(path.join(p.dir, 'state', 'inbox')), [], 'the proof directory was removed');
});

test('docs/api.md lists exactly the actions the server exposes', () => {
  const { ACTIONS } = require('../lib/actions');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'api.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## Actions'), doc.indexOf('## Writes'));
  const documented = new Set(section.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => [...l.split('|')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1])));
  assert.deepEqual([...documented].sort(), Object.keys(ACTIONS).map((n) => n.replace('herdr.', '')).sort());
});

// ---------------- proof matrix generator: evidence only, no private material, no overclaiming ----------------
const { buildReport } = require('../scripts/gen-proof-matrix');
const receiptId = require('../scripts/receipt-identity');
const realActions = require('../lib/actions');

// A schema built from the actions' own declarations, so each row can be made to pass or to fail on purpose.
function synthSchema(actions) {
  const methods = new Map();
  const add = (m, props = [], required = []) => methods.set(m, { props, required });
  for (const a of Object.values(actions)) {
    if (a.proof.sock) add(a.proof.sock, [...(a.proof.forwards.required || []), ...(a.proof.forwards.optional || [])], a.proof.forwards.required || []);
    for (const u of a.proof.uses || []) if (!methods.has(u)) add(u);
  }
  for (const m of ['ping', 'session.snapshot', 'events.subscribe', 'pane.get', 'pane.read', 'pane.process_info']) if (!methods.has(m)) add(m);
  const defs = {}; const oneOf = [];
  for (const [m, d] of methods) {
    const name = 'P_' + m.replace(/\W/g, '_');
    defs[name] = { properties: Object.fromEntries(d.props.map((k) => [k, {}])), required: d.required };
    oneOf.push({ properties: { method: { const: m }, params: { $ref: '#/schemas/request/$defs/' + name } } });
  }
  return { protocol: 22, schemas: { request: { oneOf, $defs: defs } } };
}
function report(over = {}) {
  const actions = over.actions || realActions.ACTIONS;
  const schema = over.schema || synthSchema(actions);
  const identity = receiptId.make({ herdrVersion: '0.9.3', protocol: 22 });
  return buildReport({ actions, methodOf: realActions.methodOf, schema, herdrVersion: '0.9.3', pinned: '0.9.3', portalVersion: '1.0.0', readDoc: () => '', cliCheck: () => ({ ok: true, text: 'cli ok' }), receipts: {}, identity, generatedAt: '2026-10-13T00:00:00Z', ...over });
}
const rowOf = (r, name) => r.rows.find((x) => x.name === name);

test('proof matrix: contract passes for the real allowlist against a schema that matches its declarations', () => {
  const r = report(); // the documentation is stubbed empty here, so only the schema half of each row is asserted
  for (const n of ['herdr.ping', 'herdr.pane_read', 'herdr.agent_start', 'herdr.pane_send_keys']) assert.match(rowOf(r, n).line, /forwarded: /, n);
  assert.ok(!/\*\*FORWARDED PARAMETERS DO NOT MATCH/.test(r.markdown), 'every declared parameter list matches the synthetic schema');
});

test('receipt identity: the code digest covers every server module, so a security.js change is a different build', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-id-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(tmp, 'server.js'));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(tmp, 'lib', f));
  const before = receiptId.sourceDigest(tmp);
  assert.equal(before, receiptId.sourceDigest(ROOT));
  fs.appendFileSync(path.join(tmp, 'lib', 'security.js'), '\n// changed\n');
  assert.notEqual(receiptId.sourceDigest(tmp), before);
});

test('proof matrix: a receipt from a server running other code than the checkout is untested', () => {
  const now = receiptId.make({ herdrVersion: '0.9.3', protocol: 22, served: { code_sha256: receiptId.sourceDigest() } });
  const live = (identity) => rowOf(report({ receipts: { smoke: { identity, results: { 'herdr.ping': { ok: true, at: '2026-10-13T10:00:00Z' } } } } }), 'herdr.ping').live;
  assert.equal(live(now), 'PASS 2026-10-13');
  assert.match(live({ ...now, served_code_sha256: '1'.repeat(64) }), /^untested/);
  assert.match(live(receiptId.make({ herdrVersion: '0.9.3', protocol: 22 })), /^untested/, 'no served identity, no evidence');
});

test('proof matrix: receipt notes, screens, paths, addresses and ids never reach the document', () => {
  const identity = receiptId.make({ herdrVersion: '0.9.3', protocol: 22, served: { code_sha256: receiptId.sourceDigest() } });
  const hostile = { ok: true, at: '2026-10-13T10:00:00.000Z', note: 'SENTINEL_NOTE /home/someone/proj 127.0.0.1:8787 w9:p9 term_aa01bb https://fake-name-example.trycloudflare.com', screen: 'SENTINEL_SCREEN', base: 'http://127.0.0.1:1', token: 'tok_' + 'A1'.repeat(20) };
  const r = report({ receipts: { smoke: { identity, base: 'http://127.0.0.1:1', results: { 'herdr.ping': hostile, 'herdr.pane_get': { ...hostile, ok: false } } }, decision: { identity, results: { 'herdr.audit_tail': hostile } } } });
  assert.ok(!/SENTINEL|home\/someone|trycloudflare|aa01bb|tok_|127\.0\.0\.1|w9:p9/.test(r.markdown), 'nothing from a receipt but pass/fail and a date');
  assert.deepEqual(r.leaks, []);
  assert.equal(rowOf(r, 'herdr.ping').live, 'PASS 2026-10-13');
  assert.equal(rowOf(r, 'herdr.pane_get').live, 'FAIL 2026-10-13');
  assert.equal(rowOf(r, 'herdr.audit_tail').live, 'PASS 2026-10-13');
});

test('proof matrix: a receipt counts only for this exact source and Herdr build; anything else is untested', () => {
  const now = receiptId.make({ herdrVersion: '0.9.3', protocol: 22, served: { code_sha256: receiptId.sourceDigest() } });
  const results = { 'herdr.ping': { ok: true, at: '2026-10-13T10:00:00Z' } };
  const live = (identity, at) => rowOf(report({ receipts: { smoke: { identity, results: { 'herdr.ping': { ok: true, at } } } } }), 'herdr.ping').live;
  assert.equal(live(now, '2026-10-13T10:00:00Z'), 'PASS 2026-10-13');
  for (const other of [{ ...now, source_sha256: '0'.repeat(64) }, { ...now, herdr_version: '0.9.2' }, { ...now, protocol: 21 }, { ...now, protocol: null }, undefined, null, {}]) assert.match(live(other, '2026-10-13T10:00:00Z'), /^untested \(receipt is for another/, JSON.stringify(other));
  assert.equal(live(now, 'yesterday'), 'untested');
  assert.equal(rowOf(report(), 'herdr.ping').live, 'untested');
  assert.deepEqual(Object.keys(results), ['herdr.ping']);
  // editing the code the receipt vouched for changes the identity
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-id-'));
  try {
    for (const f of ['server.js', 'lib/actions.js']) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'a'); }
    const before = receiptId.sourceDigest(root); fs.appendFileSync(path.join(root, 'lib/actions.js'), 'b');
    assert.notEqual(receiptId.sourceDigest(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('proof matrix: a missing native method or a wrong forwarded parameter list fails the contract, and a failure disables nothing', () => {
  const clone = () => Object.fromEntries(Object.entries(realActions.ACTIONS).map(([k, v]) => [k, { ...v, proof: { ...v.proof, forwards: v.proof.forwards && { ...v.proof.forwards } } }]));
  const withEdit = (edit) => { const a = clone(); edit(a); return report({ actions: a, schema: synthSchema(clone()) }); }; // the schema keeps the true declarations
  const unknownField = withEdit((a) => { a['herdr.agent_get'].proof.forwards = { required: ['target', 'bogus'] }; });
  assert.equal(rowOf(unknownField, 'herdr.agent_get').contractOk, false); assert.match(unknownField.markdown, /not in schema: `bogus`/);
  const missingRequired = withEdit((a) => { a['herdr.workspace_get'].proof.forwards = { required: [] }; });
  assert.equal(rowOf(missingRequired, 'herdr.workspace_get').contractOk, false); assert.match(missingRequired.markdown, /required but not sent: `workspace_id`/);
  const undeclared = withEdit((a) => { delete a['herdr.agent_list'].proof.forwards; });
  assert.equal(rowOf(undeclared, 'herdr.agent_list').contractOk, false); assert.match(undeclared.markdown, /not declared/);
  const noMethod = (() => { const a = clone(); a['herdr.agent_get'].proof.sock = 'agent.no_such_method'; return report({ actions: a, schema: synthSchema(clone()) }); })();
  assert.equal(rowOf(noMethod, 'herdr.agent_get').contractOk, false); assert.match(noMethod.markdown, /NOT IN SCHEMA/);
  assert.ok(noMethod.contractFails > 0);
  // the failed row still says "on": the document reports, it does not switch anything
  assert.match(rowOf(noMethod, 'herdr.agent_get').line, /\*\*FAIL\*\* \| untested \| on \|$/);
  assert.ok(!/DISABLED/.test(noMethod.markdown));
  assert.match(noMethod.markdown, /enables and disables nothing/);
});

test('proof matrix: agent_decision is shown as off by default with its opt-in, and the trust-grant narrative is gone', () => {
  const r = report();
  assert.match(rowOf(r, 'herdr.agent_decision').line, /off by default; operator opt-in: `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` \|$/);
  assert.match(rowOf(r, 'herdr.agent_send_keys').line, / \| on \|$/);
  assert.ok(!/trust this folder|folder-trust|Smoke-tested live|answered through agent_decision/i.test(r.markdown));
  assert.match(r.markdown, /not a statement that answering dialogs is safe/);
});

test('proof matrix: the control actions are shown as off by default with the owner switch that turns them on', () => {
  const r = report();
  for (const name of ['herdr.pane_scroll', 'herdr.pane_click']) {
    assert.match(rowOf(r, name).line, / \| off by default; owner switch: `HERDR_PORTAL_ENABLE_CONTROL=1` \|$/, name);
  }
});

test('proof matrix: a document that would contain a path, address, tunnel name or id is refused', () => {
  assert.deepEqual(report({ herdrVersion: '0.9.3 at /home/someone/bin' }).leaks, ['home or temp path']);
  assert.deepEqual(report({ pinned: 'fake-name-example.trycloudflare.com' }).leaks, ['tunnel hostname']);
  assert.deepEqual(report().leaks, [], 'the real generated text is clean');
});

test('gen-proof-matrix --check writes nothing; a plain run writes the document', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gen-'));
  try {
    for (const d of ['lib', 'scripts']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(root, 'server.js')); // part of the receipt code digest
    fs.mkdirSync(path.join(root, 'docs', 'official'), { recursive: true });
    for (const f of ['cli-reference', 'socket-api', 'agent-automation']) fs.writeFileSync(path.join(root, 'docs', 'official', f + '.mdx'), '');
    fs.writeFileSync(path.join(root, 'docs', 'proof-matrix.md'), 'PLANTED\n');
    fs.writeFileSync(path.join(root, 'schema.json'), JSON.stringify(synthSchema(realActions.ACTIONS)));
    const bin = path.join(root, 'herdr');
    fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in --version) echo "herdr 0.9.3";; api) cat '${path.join(root, 'schema.json')}';; *) echo "Usage: herdr $*";; esac\n`, { mode: 0o755 });
    const env = { HERDR_BIN: bin, HOME: root, HERDR_PORTAL_STATE_DIR: path.join(root, 'st'), HERDR_PORTAL_LOG_DIR: path.join(root, 'lg') };
    const chk = spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-proof-matrix.js'), '--check'], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    assert.match(chk.stdout, /checked \(nothing written\)/, chk.stdout + chk.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'proof-matrix.md'), 'utf8'), 'PLANTED\n');
    const wr = spawnSync(process.execPath, [path.join(root, 'scripts', 'gen-proof-matrix.js')], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    assert.match(wr.stdout, /wrote docs\/proof-matrix\.md/, wr.stdout + wr.stderr);
    assert.match(fs.readFileSync(path.join(root, 'docs', 'proof-matrix.md'), 'utf8'), /^# Proof matrix/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------- portalctl install: everything is checked before anything is written ----------------
const net = require('node:net');
function installKit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-inst-'));
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(dir, 'bin')); fs.mkdirSync(home);
  const sh = (name, body, mode = 0o755) => { const f = path.join(dir, 'bin', name); fs.writeFileSync(f, '#!/bin/sh\n' + body + '\n', { mode }); return f; };
  const kit = { dir, home, sh, log: path.join(dir, 'launchctl.log'), loaded: path.join(dir, 'loaded') };
  kit.launchctl = sh('launchctl', `echo "$@" >> '${kit.log}'\nif [ "$1" = print ] && [ ! -e '${kit.loaded}' ]; then exit 113; fi\nexit 0`);
  kit.herdr = sh('herdr', 'if [ "$1" = "--version" ]; then echo "herdr 0.9.3"; exit 0; fi\nexit 1');
  kit.cloudflared = sh('cloudflared', 'exit 0');
  kit.env = (over = {}) => ({ PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, HOME: home, HERDR_PORTAL_STATE_DIR: path.join(dir, 'st'), HERDR_PORTAL_LOG_DIR: path.join(dir, 'lg'), HERDR_PORTAL_PORT: String(20000 + Math.floor(Math.random() * 20000)), HERDR_BIN: kit.herdr, CLOUDFLARED_BIN: kit.cloudflared, HERDR_PORTAL_LAUNCHCTL: kit.launchctl, ...over });
  kit.untouched = () => assert.deepEqual(fs.readdirSync(home), [], 'no LaunchAgent or other file was written') || assert.ok(!fs.existsSync(path.join(dir, 'st')), 'no state directory or token was created');
  kit.calls = () => (fs.existsSync(kit.log) ? fs.readFileSync(kit.log, 'utf8').trim().split('\n').filter((l) => !l.startsWith('print ')) : []);
  return kit;
}
const refused = async (kit, env, re) => {
  const r = await runAsync(['bin/portalctl', 'install'], env);
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, re); assert.match(r.stderr, /nothing was written and no service was started/);
  kit.untouched(); assert.deepEqual(kit.calls(), [], 'launchctl was never asked to change anything');
};

test('portalctl url and status understand a named tunnel run by the cloudflared service (a LaunchAgent or a LaunchDaemon, not tunnel-runner.js)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-ctl-'));
  const lcFile = path.join(home, 'launchctl');
  const state = path.join(home, 'st'); fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'tunnel.json'), JSON.stringify({ mode: 'named', hostname: 'portal.example.org' }));
  const env = (loaded) => ({ HOME: home, HERDR_PORTAL_STATE_DIR: state, HERDR_PORTAL_LOG_DIR: path.join(home, 'lg'), HERDR_PORTAL_PORT: '1', HERDR_PORTAL_LAUNCHCTL: lcFile, FAKE_DAEMON: loaded === 'gui' ? 'gui' : loaded ? '1' : '0' });
  fs.writeFileSync(lcFile, '#!/bin/sh\nif [ "$1" = print ] && [ "$FAKE_DAEMON" = 1 ] && [ "$2" = system/com.cloudflare.cloudflared ]; then printf "state = running\\npid = 4242\\n"; exit 0; fi\nif [ "$1" = print ] && [ "$FAKE_DAEMON" = gui ] && [ "$2" = "gui/$(id -u)/com.cloudflare.cloudflared" ]; then printf "state = running\\npid = 4243\\n"; exit 0; fi\nexit 1\n', { mode: 0o755 });
  try {
    const up = run(['bin/portalctl', 'url'], env(true));
    assert.match(up.stdout, /public url: https:\/\/portal\.example\.org {2}\(named tunnel, persistent\)/);
    assert.match(run(['bin/portalctl', 'url'], env(false)).stdout, /public url: none/, 'nothing is printed when the daemon is not loaded');
    assert.match(run(['bin/portalctl', 'status'], env(true)).stdout, /daemon {2}com\.cloudflare\.cloudflared: loaded, state=running, pid=4242/);
    assert.ok(!/daemon {2}com\.cloudflare/.test(run(['bin/portalctl', 'status'], env(false)).stdout));
    assert.match(run(['bin/portalctl', 'url'], env('gui')).stdout, /public url: https:\/\/portal\.example\.org/, 'a service installed without sudo is a LaunchAgent in the user domain');
    assert.match(run(['bin/portalctl', 'status'], env('gui')).stdout, /daemon {2}com\.cloudflare\.cloudflared: loaded, state=running, pid=4243/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('portalctl install refuses, before writing anything, when herdr is not an absolute path, not executable, or fails under launchd\'s environment', async (t) => {
  const kit = installKit(); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  await refused(kit, kit.env({ HERDR_BIN: 'herdr-shim' }), /not an absolute path/);
  await refused(kit, kit.env({ HERDR_BIN: kit.sh('herdr-plain', 'exit 0', 0o644) }), /not an executable file/);
  await refused(kit, kit.env({ HERDR_BIN: kit.sh('herdr-broken', 'exit 3') }), /--version failed under launchd's minimal environment \(exit 3\)/);
  await refused(kit, kit.env({ HERDR_BIN: kit.sh('herdr-needs-env', 'if [ -z "$MISE_SHIM_HOME" ]; then exit 4; fi\necho "herdr 0.9.3"') }), /exit 4/);
});

test('portalctl install refuses when the port is already served by something that is not this label, and says how to choose a fresh instance', async (t) => {
  const kit = installKit(); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const occupant = net.createServer(); await new Promise((r) => occupant.listen(port, '127.0.0.1', r)); t.after(() => occupant.close());
  const env = kit.env({ HERDR_PORTAL_PORT: String(port) });
  await refused(kit, env, /already in use/);
  const r = await runAsync(['bin/portalctl', 'install'], env);
  assert.match(r.stderr, /HERDR_PORTAL_PORT, HERDR_PORTAL_STATE_DIR and HERDR_PORTAL_LOG_DIR/); assert.match(r.stderr, /never renames, copies or rotates existing state/);
});

test('portalctl install on a fresh instance writes the LaunchAgents and starts them through launchctl (a fake one); without cloudflared it installs the portal only', async (t) => {
  const kit = installKit(); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const ok = await runAsync(['bin/portalctl', 'install'], kit.env());
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const agents = path.join(kit.home, 'Library', 'LaunchAgents');
  assert.deepEqual(fs.readdirSync(agents).sort(), ['dev.herdr-portal.plist', 'dev.herdr-portal.tunnel.plist']);
  assert.ok(fs.existsSync(path.join(kit.dir, 'st', 'secrets', 'portal-token')), 'token created');
  assert.equal(kit.calls().filter((l) => l.startsWith('bootstrap ')).length, 2);
  // a second kit: no cloudflared anywhere
  const k2 = installKit(); t.after(() => fs.rmSync(k2.dir, { recursive: true, force: true }));
  const env2 = k2.env(); delete env2.CLOUDFLARED_BIN; fs.rmSync(k2.cloudflared);
  const r2 = await runAsync(['bin/portalctl', 'install'], env2);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr); assert.match(r2.stdout, /installing the portal only/);
  assert.deepEqual(fs.readdirSync(path.join(k2.home, 'Library', 'LaunchAgents')), ['dev.herdr-portal.plist']);
  assert.equal(k2.calls().filter((l) => l.startsWith('bootstrap ')).length, 1);
});

// A launchctl that keeps state the way launchd does for these calls: bootstrap loads the plist and starts its program
// (here a small fake portal) with the plist's EnvironmentVariables; kickstart restarts nothing new; bootout stops it.
// FAKE_LC=bootout_fails|bootstrap_fails|no_start|stuck injects one failure.
function statefulLaunchctl(kit) {
  const st = path.join(kit.dir, 'lc-state.json');
  const portal = path.join(kit.dir, 'fake-portal.js');
  fs.writeFileSync(portal, `const http = require('http'); const fs = require('fs'); const crypto = require('crypto');
const build = { instance_id: crypto.randomBytes(16).toString('hex'), started_at: new Date().toISOString(), flags: { strict_version: process.env.HERDR_PORTAL_STRICT_VERSION === '1', agent_decision: process.env.HERDR_PORTAL_ENABLE_AGENT_DECISION === '1' } };
const tok = () => fs.readFileSync(process.env.HERDR_PORTAL_STATE_DIR + '/secrets/portal-token', 'utf8').trim();
http.createServer((q, r) => { if (q.headers.authorization === 'Bearer ' + tok()) fs.appendFileSync(${JSON.stringify(path.join(kit.dir, 'token-hits'))}, '1\\n'); const ok = q.url === '/api/health' && q.headers.authorization === 'Bearer ' + tok(); r.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(ok ? { ok: true, build, capabilities: require(${JSON.stringify(path.join(ROOT, 'lib', 'gates'))}).capabilities() } : { ok: false })); })
  .listen(Number(process.env.HERDR_PORTAL_PORT), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);
  const lc = path.join(kit.dir, 'bin', 'launchctl');
  fs.writeFileSync(lc, `#!${process.execPath}
const fs = require('fs'); const { spawn } = require('child_process');
const [cmd, ...a] = process.argv.slice(2); const mode = process.env.FAKE_LC || '';
fs.appendFileSync(${JSON.stringify(kit.log)}, [cmd, ...a].join(' ') + '\\n');
const st = fs.existsSync(${JSON.stringify(st)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(st)}, 'utf8')) : {};
const save = () => fs.writeFileSync(${JSON.stringify(st)}, JSON.stringify(st));
const label = (x) => x.split('/').pop().replace(/\\.plist$/, '');
if (cmd === 'print') process.exit(st[label(a[0])] ? 0 : 113);
if (cmd === 'enable' || cmd === 'kickstart') process.exit(0);
if (cmd === 'bootout') {
  if (mode === 'bootout_fails') { process.stderr.write('Boot-out failed: 5: Input/output error'); process.exit(5); }
  const j = st[label(a[0])]; if (j && j.pid) { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
  if (mode !== 'stuck') delete st[label(a[0])]; else st[label(a[0])].pid = null;
  save(); process.exit(0);
}
if (cmd === 'bootstrap') {
  if (mode === 'bootstrap_fails') { process.stderr.write('Bootstrap failed: 5: Input/output error'); process.exit(5); }
  const xml = fs.readFileSync(a[1], 'utf8'); const env = {};
  for (const m of xml.split('<key>EnvironmentVariables</key>')[1].split('</dict>')[0].matchAll(/<key>([^<]+)<\\/key><string>([^<]*)<\\/string>/g)) env[m[1]] = m[2];
  let pid = null;
  if (label(a[1]).endsWith('.tunnel') || mode === 'no_start') pid = null;
  else { const c = spawn(process.execPath, [${JSON.stringify(portal)}], { env, detached: true, stdio: 'ignore' }); c.unref(); pid = c.pid; fs.appendFileSync(${JSON.stringify(st + '.pids')}, pid + '\\n'); }
  st[label(a[1])] = { pid }; save(); process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  const health = async (env) => {
    const t = fs.readFileSync(path.join(kit.dir, 'st', 'secrets', 'portal-token'), 'utf8').trim();
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`http://127.0.0.1:${env.HERDR_PORTAL_PORT}/api/health`, { headers: { Authorization: 'Bearer ' + t } }).catch(() => null);
      if (r && r.status === 200) { const j = await r.json(); return { ...j.build, capabilities: j.capabilities }; }
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return null;
  };
  const kill = () => { for (const pid of (fs.existsSync(st + '.pids') ? fs.readFileSync(st + '.pids', 'utf8') : '').split('\n').filter(Boolean)) try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ } };
  const hits = () => { const f = path.join(kit.dir, 'token-hits'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0; };
  return { launchctl: lc, health, kill, hits, plist: path.join(kit.home, 'Library', 'LaunchAgents', 'dev.herdr-portal.plist') };
}

// portalctl manages launchd and checks who owns the port with lsof at its macOS path; Linux CI has lsof elsewhere, so these three cannot reach the token.
const NO_MAC_LSOF = !fs.existsSync('/usr/sbin/lsof') && 'no lsof at /usr/sbin/lsof (macOS path)';
test('portalctl install over a loaded portal boots it out, waits, bootstraps the new definition and proves a new instance with the new flags', { skip: NO_MAC_LSOF }, async (t) => {
  const kit = installKit(); const f = statefulLaunchctl(kit);
  t.after(f.kill); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true })); // stop the fake portals before their state is removed
  const env = kit.env({ HERDR_PORTAL_LAUNCHCTL: f.launchctl });
  const first = await runAsync(['bin/portalctl', 'install'], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const old = await f.health(env); assert.equal(old.flags.strict_version, false);
  fs.writeFileSync(kit.log, '');
  const again = await runAsync(['bin/portalctl', 'install'], { ...env, HERDR_PORTAL_STRICT_VERSION: '1' });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const now = await f.health(env);
  assert.notEqual(now.instance_id, old.instance_id, 'a new process answers');
  assert.equal(now.flags.strict_version, true, 'the strict flag the reinstall set is in effect');
  const calls = kit.calls(); const portalCalls = calls.filter((l) => /dev\.herdr-portal(\.plist)?$/.test(l));
  assert.deepEqual(portalCalls.map((l) => l.split(' ')[0]), ['bootout', 'enable', 'bootstrap'], calls.join('\n'));
  assert.ok(!calls.some((l) => l.startsWith('kickstart')), 'kickstart would keep the old definition');
  assert.match(again.stdout, /portal booted out \(was loaded\)/); assert.match(again.stdout, /portal new instance [0-9a-f]{8} started .*"strict_version":true/);
  const tok = fs.readFileSync(path.join(kit.dir, 'st', 'secrets', 'portal-token'), 'utf8').trim();
  assert.ok(!(again.stdout + again.stderr).includes(tok), 'the token is never printed');
  const revoke = await runAsync(['bin/portalctl', 'install'], env);
  assert.equal(revoke.status, 0, revoke.stdout + revoke.stderr);
  const after = await f.health(env);
  assert.notEqual(after.instance_id, now.instance_id); assert.equal(after.flags.strict_version, false, 'a reinstall without the flag revokes it in the running portal');
});

test('portalctl install proves the history, control and agent-click switches the same way, and a reinstall without them turns them off again', { skip: NO_MAC_LSOF }, async (t) => {
  const kit = installKit(); const f = statefulLaunchctl(kit);
  t.after(f.kill); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const env = kit.env({ HERDR_PORTAL_LAUNCHCTL: f.launchctl });
  const first = await runAsync(['bin/portalctl', 'install'], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual((await f.health(env)).capabilities, { history: false, control: false, agent_click: false }, 'nothing is on unless the installer asked');
  const on = await runAsync(['bin/portalctl', 'install'], { ...env, HERDR_PORTAL_ENABLE_HISTORY: 'agents', HERDR_PORTAL_ENABLE_CONTROL: '1', HERDR_PORTAL_ENABLE_AGENT_CLICK: '1' });
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.deepEqual((await f.health(env)).capabilities, { history: 'agents', control: true, agent_click: true });
  assert.match(on.stdout, /capabilities \{"history":"agents","control":true,"agent_click":true\}/);
  const typo = await runAsync(['bin/portalctl', 'install'], { ...env, HERDR_PORTAL_ENABLE_CONTROL: 'true' });
  assert.equal(typo.status, 0, typo.stdout + typo.stderr);
  assert.match(typo.stderr, /warning: HERDR_PORTAL_ENABLE_CONTROL=true is not a value the portal accepts \(1\)/);
  assert.equal((await f.health(env)).capabilities.control, false, 'a typo is dropped, not passed on');
  const off = await runAsync(['bin/portalctl', 'install'], env);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.deepEqual((await f.health(env)).capabilities, { history: false, control: false, agent_click: false }, 'the plist is rewritten on every install, so a switch not set at install time is gone');
});

test('portalctl reinstall never sends the token to a listener that is not owned by this user, and fails instead of claiming proof', { skip: NO_MAC_LSOF }, async (t) => {
  const kit = installKit(); const f = statefulLaunchctl(kit);
  t.after(f.kill); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const env = kit.env({ HERDR_PORTAL_LAUNCHCTL: f.launchctl });
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  for (const [name, body] of [['lsof-other', 'printf "p99\\nu0\\n"'], ['lsof-unreadable', 'exit 1']]) {
    const sent = f.hits();
    const r = await runAsync(['bin/portalctl', 'install'], { ...env, HERDR_PORTAL_LSOF: kit.sh(name, body) });
    assert.equal(f.hits(), sent, name + ': the token reached a listener that was not proven to be ours');
    assert.equal(r.status, 1, name + ': ' + r.stdout + r.stderr);
    assert.match(r.stderr, /no new portal instance answered/, name);
    assert.match(r.stdout + r.stderr, /not owned by this user|could not confirm/, name);
  }
  const sent = f.hits();
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  assert.ok(f.hits() > sent, 'control: a listener owned by this user does receive the token, so the counter works');
});

test('portalctl reinstall reports why the last health check failed, not an ownership refusal from an earlier poll', async (t) => {
  const kit = installKit(); const f = statefulLaunchctl(kit);
  t.after(f.kill); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const env = kit.env({ HERDR_PORTAL_LAUNCHCTL: f.launchctl });
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  // the second lsof call (the first poll after bootstrap) cannot read the port; every later one sees this user
  const n = path.join(kit.dir, 'lsof-n');
  const lsof = kit.sh('lsof-once', `n=$(cat '${n}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${n}'; [ $n -eq 2 ] && exit 1; printf "p1\\nu${process.getuid()}\\n"`);
  const r = await runAsync(['bin/portalctl', 'install'], { ...env, FAKE_LC: 'no_start', HERDR_PORTAL_LSOF: lsof });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no new portal instance answered/);
  assert.doesNotMatch(r.stderr, /did not send the token/, 'the last poll did send the token');
});

test('portalctl reinstall failures are nonzero and say what state the service is in', async (t) => {
  const kit = installKit(); const f = statefulLaunchctl(kit);
  t.after(f.kill); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true })); // stop the fake portals before their state is removed
  const env = kit.env({ HERDR_PORTAL_LAUNCHCTL: f.launchctl });
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  const plistBefore = fs.readFileSync(f.plist, 'utf8');
  const out = await runAsync(['bin/portalctl', 'install'], { ...env, HERDR_PORTAL_STRICT_VERSION: '1', FAKE_LC: 'bootout_fails' });
  assert.equal(out.status, 1); assert.match(out.stderr, /bootout portal failed .*still loaded and its plist was not rewritten/);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), plistBefore, 'the plist is untouched when the old job could not be removed');
  const stuck = await runAsync(['bin/portalctl', 'install'], { ...env, FAKE_LC: 'stuck' });
  assert.equal(stuck.status, 1); assert.match(stuck.stderr, /portal is still loaded 10 s after bootout; its plist was not rewritten/);
  fs.rmSync(path.join(kit.dir, 'lc-state.json'));
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  const boot = await runAsync(['bin/portalctl', 'install'], { ...env, FAKE_LC: 'bootstrap_fails' });
  assert.equal(boot.status, 1); assert.match(boot.stderr, /bootstrap portal failed.*portal is not running \(the old job was booted out\)/);
  assert.equal((await runAsync(['bin/portalctl', 'install'], env)).status, 0);
  const none = await runAsync(['bin/portalctl', 'install'], { ...env, FAKE_LC: 'no_start' });
  assert.equal(none.status, 1); assert.match(none.stderr, /no new portal instance answered \/api\/health within 10 s.*; the new definition is not proven in effect/);
});

test('lib/compat: a schema variant the reader does not know is skipped, so only actions that use it are refused', () => {
  const { parseSchema, checkAction } = require('../lib/compat');
  const idx = parseSchema({ protocol: 22, schemas: { request: { oneOf: [{ type: 'object' }, { properties: { method: { const: 'pane.get' }, params: { $ref: '#/x/$defs/P' } } }], $defs: { P: { properties: { pane_id: {} }, required: ['pane_id'] } } } } });
  assert.deepEqual([...idx.methods.keys()], ['pane.get']);
  assert.equal(checkAction(idx, { sock: 'pane.get', forwards: { required: ['pane_id'] } }, () => true), null);
  assert.match(checkAction(idx, { sock: 'pane.list', forwards: { required: [] } }, () => true), /pane\.list is not in this Herdr's schema/);
});
