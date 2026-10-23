#!/usr/bin/env node
'use strict';
// Live proof of the portal's pane tag and of the Herdr plugin, against a real Herdr in a throwaway home.
//   node scripts/e2e-plugin.js [--out docs/e2e-plugin.json] [--keep]
// It never touches your Herdr or your portal: HOME points at a fresh short directory, it links a copy of plugin/ into its own Herdr server (a session
// named "default" in that home) and starts its own portal on a random port, checks that its session is the only one listed before it sends anything,
// and stops both by exact pid at the end. Skips with exit 0 when herdr is not installed.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const ROOT = path.join(__dirname, '..');
const SESSION = 'default'; // inside the throwaway home this is not your default session
const rec = { started_at: new Date().toISOString(), herdr: null, steps: [] };
const step = (name, ok, info = {}) => { rec.steps.push({ name, ok: !!ok, ...info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info.note ? '  — ' + info.note : ''}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 150) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function findHerdr() {
  const candidates = [process.env.HERDR_BIN, ...String(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'herdr'))].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

(async () => {
  const herdrBin = findHerdr();
  if (!herdrBin) { console.log('SKIP  herdr is not installed (not on PATH, HERDR_BIN unset): nothing to prove against'); process.exit(0); }
  const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'hpg-')); // short: Unix socket paths are limited to about 100 bytes
  const pluginDir = path.join(root, 'plugin');
  fs.cpSync(path.join(ROOT, 'plugin'), pluginDir, { recursive: true }); // a copy under the throwaway home: nothing of the repository is linked
  const pluginId = (/^id\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(path.join(pluginDir, 'herdr-plugin.toml'), 'utf8')) || [])[1];
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.join(root, 'state', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'state', 'secrets', 'portal-token'), token + '\n', { mode: 0o600 });
  const logDir = path.join(root, 'Library', 'Logs', 'herdr-portal'); // the default location under the throwaway home, where the plugin looks
  const port = 20000 + Math.floor(Math.random() * 20000);
  const baseEnv = { PATH: process.env.PATH, HOME: root, TERM: 'xterm-256color', SHELL: '/bin/sh', LANG: process.env.LANG || 'en_US.UTF-8' };
  const portalEnv = { ...baseEnv, HERDR_BIN: herdrBin, HERDR_PORTAL_PORT: String(port), HERDR_PORTAL_STATE_DIR: path.join(root, 'state'), HERDR_PORTAL_LOG_DIR: logDir, HERDR_PORTAL_TAG_PANES: '1' };
  const pids = {};
  const out = (name) => fs.openSync(path.join(root, name), 'a');
  const cli = (...a) => spawnSync(herdrBin, ['--session', SESSION, ...a], { env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const json = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json: j };
  };
  const finished = (id) => { const l = [...(((json(cli('plugin', 'log', 'list', '--plugin', pluginId)) || {}).result || {}).logs || [])].reverse().find((x) => x.action_id === id); return l && l.status !== 'running' ? l : null; };
  const paneInfo = (pane) => (((json(cli('pane', 'get', pane)) || {}).result || {}).pane || {});
  const panes = () => (((json(cli('pane', 'list')) || {}).result || {}).panes || []).map((p) => p.pane_id);
  const mkPane = (label) => json(cli('workspace', 'create', '--label', label, '--cwd', root)).result.root_pane;
  const write = (action, pane, extra) => api('POST', `/api/herdr/${action}`, { session: SESSION, pane_id: pane.pane_id, expect_terminal_id: pane.terminal_id, request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });

  try {
    rec.herdr = (spawnSync(herdrBin, ['--version'], { encoding: 'utf8' }).stdout || '').trim();

    const linked = json(cli('plugin', 'link', pluginDir));
    const warnings = linked && linked.result && linked.result.plugin && linked.result.plugin.warnings;
    step('plugin link with no server running registers the plugin, with no warning', linked && linked.result && linked.result.type === 'plugin_linked' && !(warnings && warnings.length), { warnings });

    const server = spawn(herdrBin, ['--session', SESSION, 'server'], { env: baseEnv, detached: true, stdio: ['ignore', out('herdr.log'), out('herdr.log')] });
    pids.herdr = server.pid; server.unref();
    const listed = await until(async () => { const j = json(cli('session', 'list', '--json')); return j && (j.sessions || []).some((x) => x.name === SESSION && x.running) ? j.sessions : null; });
    const sessions = listed || [];
    const isolated = sessions.filter((s) => s.running).length === 1 && sessions.every((s) => String(s.socket_path).startsWith(root));
    step('the disposable Herdr started; its session is the only one running and every socket is inside the temporary home', isolated, { herdr: rec.herdr });
    if (!isolated) throw new Error('isolation failed: refusing to do anything else');

    const listing = json(cli('plugin', 'list', '--json'));
    const plugin = listing && listing.result && (listing.result.plugins || []).find((p) => p.plugin_id === pluginId);
    step('plugin list shows it enabled with three actions and one pane, and no startup hook', plugin && plugin.enabled && !(plugin.startup || []).length && plugin.actions.length === 3 && plugin.panes.length === 1 && !(plugin.warnings && plugin.warnings.length), { actions: plugin && plugin.actions.map((a) => a.id) });

    // ---- the portal tags the pane it sent input to ----
    const portal = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: portalEnv, detached: true, stdio: ['ignore', out('portal.log'), out('portal.log')] });
    pids.portal = portal.pid; portal.unref();
    const health = await until(async () => { const r = await api('GET', '/api/health'); return r.status === 200 && r.json.herdr && r.json.herdr.writes_enabled ? r.json : null; }, 20000);
    step('the portal is up with writes enabled and pane tags on', health && health.capabilities && health.capabilities.tag_panes === true, { capabilities: health && health.capabilities });
    if (!health) throw new Error('portal did not start: ' + fs.readFileSync(path.join(root, 'portal.log'), 'utf8').slice(-500));

    const A = mkPane('a'); const B = mkPane('b'); const C = mkPane('c');
    const sent = await write('pane_run', A, { text: 'echo proof' });
    const tagged = await until(async () => { const t = paneInfo(A.pane_id).tokens || {}; return t.tunnel_last ? t : null; });
    step('input the portal sent to a pane shows up as a sidebar tag on that pane', sent.status === 200 && tagged && /^run sent \d\d:\d\d$/.test(tagged.tunnel_last), { status: sent.status, tag: tagged && tagged.tunnel_last });
    const refused = await write('pane_run', { ...C, terminal_id: 'term_deadbeef' }, { text: 'echo nope' });
    await sleep(1000);
    step('a refused write and a pane that got nothing carry no tag', refused.status === 409 && !(paneInfo(C.pane_id).tokens || {}).tunnel_last && !(paneInfo(B.pane_id).tokens || {}).tunnel_last, { refused: refused.status });

    // ---- the Agents view ----
    cli('plugin', 'action', 'invoke', `${pluginId}.agents-touched`);
    const set = await until(async () => finished('agents-touched'));
    cli('plugin', 'action', 'invoke', `${pluginId}.agents-all`);
    const cleared = await until(async () => finished('agents-all'));
    step('the view actions set the Agents view owned by the plugin and then clear it', set && set.status === 'succeeded' && /"active":true/.test(set.stdout) && cleared && cleared.status === 'succeeded' && /"active":false/.test(cleared.stdout), { set: set && String(set.stdout || '').trim(), cleared: cleared && String(cleared.stdout || '').trim() });

    // ---- the activity tab ----
    const before = new Set(panes());
    cli('plugin', 'action', 'invoke', `${pluginId}.activity`);
    const act = await until(async () => finished('activity'));
    const fresh = await until(async () => { const n = panes().filter((p) => !before.has(p)); return n.length === 1 ? n[0] : null; });
    step('the activity action opens one new pane, as a tab, and exits 0', act && act.status === 'succeeded' && act.exit_code === 0 && !!fresh, { status: act && act.status, stderr: act && String(act.stderr || '').slice(0, 200), pane: fresh });
    const readFresh = () => cli('pane', 'read', fresh, '--source', 'visible').stdout || '';
    const screen = await until(async () => { const t = readFresh(); return /Herdr portal activity/.test(t) && /run +w\d+:p\d+ +sent/.test(t) && /refused 409 target_changed/.test(t) ? t : null; });
    step('the tab draws the log: the portal state, the run that was sent and the one that was refused', !!screen, { head: screen && screen.split('\n')[0] });
    cli('pane', 'send-text', fresh, 'p'); await sleep(600);
    const paused = /paused/.test(readFresh().split('\n').slice(0, 2).join('\n'));
    cli('pane', 'send-text', fresh, 'q'); await sleep(1000);
    const ended = !/Herdr portal activity/.test(readFresh()) || !panes().includes(fresh);
    step('p pauses the screen and q ends it', paused && ended, { paused, ended });
  } catch (e) {
    step('the proof ran to the end', false, { note: String(e && e.message).slice(0, 300) });
  } finally {
    for (const name of ['portal', 'herdr']) { if (pids[name] && alive(pids[name])) { try { process.kill(pids[name], 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1200);
    for (const name of ['portal', 'herdr']) { if (pids[name] && alive(pids[name])) { try { process.kill(pids[name], 'SIGKILL'); } catch { /* gone */ } } }
    if (!args.keep) fs.rmSync(root, { recursive: true, force: true });
  }
  rec.finished_at = new Date().toISOString(); rec.ok = rec.steps.length > 0 && rec.steps.every((s) => s.ok);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(rec, null, 2));
  console.log(rec.ok ? `\nALL ${rec.steps.length} STEPS PASSED on ${rec.herdr}` : '\nFAILED');
  process.exit(rec.ok ? 0 : 1);
})();
