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
  assert.match(saved.identity.source_sha256, /^[0-9a-f]{64}$/); assert.equal(saved.identity.herdr_version, '0.9.3'); assert.equal(saved.identity.protocol, 22);
  assert.ok(!JSON.stringify(saved).includes('127.0.0.1') && !JSON.stringify(saved).includes(p.dir), 'no address or path in the receipt');
  const d = await runAsync(['scripts/decision-proof.js', '--base', p.base], p.env);
  assert.equal(d.status, 2); assert.match(d.stderr, /missing --refuse-pane/);
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

test('proof matrix: receipt notes, screens, paths, addresses and ids never reach the document', () => {
  const identity = receiptId.make({ herdrVersion: '0.9.3', protocol: 22 });
  const hostile = { ok: true, at: '2026-10-13T10:00:00.000Z', note: 'SENTINEL_NOTE /home/someone/proj 127.0.0.1:8787 w9:p9 term_aa01bb https://fake-name-example.trycloudflare.com', screen: 'SENTINEL_SCREEN', base: 'http://127.0.0.1:1', token: 'tok_' + 'A1'.repeat(20) };
  const r = report({ receipts: { smoke: { identity, base: 'http://127.0.0.1:1', results: { 'herdr.ping': hostile, 'herdr.pane_get': { ...hostile, ok: false } } }, decision: { identity, results: { 'herdr.audit_tail': hostile } } } });
  assert.ok(!/SENTINEL|home\/someone|trycloudflare|aa01bb|tok_|127\.0\.0\.1|w9:p9/.test(r.markdown), 'nothing from a receipt but pass/fail and a date');
  assert.deepEqual(r.leaks, []);
  assert.equal(rowOf(r, 'herdr.ping').live, 'PASS 2026-10-13');
  assert.equal(rowOf(r, 'herdr.pane_get').live, 'FAIL 2026-10-13');
  assert.equal(rowOf(r, 'herdr.audit_tail').live, 'PASS 2026-10-13');
});

test('proof matrix: a receipt counts only for this exact source and Herdr build; anything else is untested', () => {
  const now = receiptId.make({ herdrVersion: '0.9.3', protocol: 22 });
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
    for (const f of receiptId.FILES) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), 'a'); }
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

test('proof matrix: a document that would contain a path, address, tunnel name or id is refused', () => {
  assert.deepEqual(report({ herdrVersion: '0.9.3 at /home/someone/bin' }).leaks, ['home or temp path']);
  assert.deepEqual(report({ pinned: 'fake-name-example.trycloudflare.com' }).leaks, ['tunnel hostname']);
  assert.deepEqual(report().leaks, [], 'the real generated text is clean');
});

test('gen-proof-matrix --check writes nothing; a plain run writes the document', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-gen-'));
  try {
    for (const d of ['lib', 'scripts']) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
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

test('portalctl install over an already loaded label is allowed even though that job holds the port', async (t) => {
  const kit = installKit(); t.after(() => fs.rmSync(kit.dir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const occupant = net.createServer(); await new Promise((r) => occupant.listen(port, '127.0.0.1', r)); t.after(() => occupant.close());
  fs.writeFileSync(kit.loaded, '');
  const r = await runAsync(['bin/portalctl', 'install'], kit.env({ HERDR_PORTAL_PORT: String(port) }));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(kit.calls().some((l) => l.startsWith('kickstart ')), 'the loaded job was kickstarted');
});
