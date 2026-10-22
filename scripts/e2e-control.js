#!/usr/bin/env node
'use strict';
// Live proof of history reads, scrolling and clicking against a real Herdr in a throwaway home.
//   node scripts/e2e-control.js [--out docs/e2e-control.json] [--keep]
// It never touches your Herdr or your portal: HOME, the portal state and log directories point at a fresh short directory,
// it starts its own Herdr server (a session named "default" in that home) and its own portal on a random port, checks that its session is the only
// one listed before sending anything, and stops both by exact pid at the end. Skips with exit 0 when herdr is not installed.
// The portal runs detached, so it has no controlling terminal: the proof that the terminal size can be read that way.
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const ROOT = path.join(__dirname, '..');
const SESSION = 'default'; // inside the throwaway home this is not your default session; scripts/e2e.js addresses it by this name
const rec = { started_at: new Date().toISOString(), herdr: null, steps: [] };
const step = (name, ok, info = {}) => { rec.steps.push({ name, ok: !!ok, ...info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info.note ? '  — ' + info.note : ''}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 150) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) return null; await sleep(every); }
}

function findHerdr() {
  const candidates = [process.env.HERDR_BIN, ...String(process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'herdr'))].filter(Boolean);
  return candidates.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const MOUSE_APP = `
const fs = require('fs');
const log = (f, o) => fs.appendFileSync(f, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1002h\\x1b[?1006h');
const draw = () => {
  process.stdout.write('\\x1b[2J\\x1b[H');
  for (let r = 1; r <= (process.stdout.rows || 24) - 1; r++) process.stdout.write('\\x1b[' + r + ';1Hrow ' + String(r).padStart(2, '0') + ' ' + '.'.repeat(30));
};
log('size.log', { init: [process.stdout.columns, process.stdout.rows] });
draw();
process.stdout.on('resize', () => { log('size.log', { resize: [process.stdout.columns, process.stdout.rows] }); draw(); });
process.stdin.on('data', (b) => {
  const s = b.toString('latin1');
  log('mouse.log', { bytes: s });
  if (s === 'q') { process.stdout.write('\\x1b[?1000l\\x1b[?1002l\\x1b[?1006l\\x1b[?1049l'); process.exit(0); }
});
`;

(async () => {
  const herdrBin = findHerdr();
  if (!herdrBin) { console.log('SKIP  herdr is not installed (not on PATH, HERDR_BIN unset): nothing to prove against'); process.exit(0); }

  const root = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'hpc-')); // short: Unix socket paths are limited to about 100 bytes
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.join(root, 'state', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'state', 'secrets', 'portal-token'), token + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'mouse-app.js'), MOUSE_APP);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const baseEnv = { PATH: process.env.PATH, HOME: root, TERM: 'xterm-256color', SHELL: '/bin/sh', LANG: process.env.LANG || 'en_US.UTF-8' };
  const portalEnv = {
    ...baseEnv, HERDR_BIN: herdrBin, HERDR_PORTAL_PORT: String(port), HERDR_PORTAL_STATE_DIR: path.join(root, 'state'), HERDR_PORTAL_LOG_DIR: path.join(root, 'logs'),
    HERDR_PORTAL_ENABLE_HISTORY: 'all', HERDR_PORTAL_ENABLE_CONTROL: '1',
  };
  const pids = {};
  const out = (name) => fs.openSync(path.join(root, name), 'a');
  const cli = (...a) => spawnSync(herdrBin, ['--session', SESSION, ...a], { env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const api = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json };
  };
  const stopAll = async () => {
    for (const name of ['portal', 'herdr']) { if (pids[name]) { try { process.kill(pids[name], 'SIGTERM'); } catch { /* already gone */ } } }
    await sleep(1200);
    for (const name of ['portal', 'herdr']) { if (pids[name]) { try { process.kill(pids[name], 0); process.kill(pids[name], 'SIGKILL'); } catch { /* gone */ } } }
    if (!args.keep) fs.rmSync(root, { recursive: true, force: true });
  };
  let sockPath = null;
  const sockCall = (method, params) => new Promise((resolve, reject) => {
    const s = net.connect(sockPath); let buf = '';
    s.on('data', (d) => { buf += d; if (buf.endsWith('\n')) { s.end(); try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } } });
    s.on('error', reject); s.write(JSON.stringify({ id: 'p', method, params }) + '\n');
  });

  try {
    // ---- isolation: our own server and nothing else ----
    rec.herdr = (spawnSync(herdrBin, ['--version'], { encoding: 'utf8' }).stdout || '').trim();
    const server = spawn(herdrBin, ['--session', SESSION, 'server'], { env: baseEnv, detached: true, stdio: ['ignore', out('herdr.log'), out('herdr.log')] });
    pids.herdr = server.pid; server.unref();
    // The throwaway home has its own "default" session: only one session may be running, and every socket must be inside the home.
    const listed = await until(async () => { const j = JSON.parse(cli('session', 'list', '--json').stdout); return (j.sessions || []).some((x) => x.name === SESSION && x.running) ? j.sessions : null; });
    const sessions = listed || [];
    const running = sessions.filter((s) => s.running);
    sockPath = (sessions.find((s) => s.name === SESSION) || {}).socket_path;
    step('the disposable Herdr started; its session is the only one running and every socket is inside the temporary home', running.length === 1 && running[0].name === SESSION && sessions.every((s) => String(s.socket_path).startsWith(root)), { herdr: rec.herdr, running: running.map((s) => s.name) });
    if (running.length !== 1 || !sessions.every((s) => String(s.socket_path).startsWith(root))) throw new Error('isolation failed: refusing to send anything');

    const mkWs = (label) => JSON.parse(cli('workspace', 'create', '--label', label, '--cwd', root).stdout).result.root_pane;
    const [P1, P2, P3, P4] = ['shell', 'mouse', 'agent', 'write'].map(mkWs); // shell with scrollback / mouse app / fake agent / write round trip
    step('four panes exist in the disposable session', [P1, P2, P3, P4].every((p) => p && p.pane_id && p.terminal_id), { panes: 4 });

    // ---- portal, detached: no controlling terminal ----
    const portal = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: portalEnv, detached: true, stdio: ['ignore', out('portal.log'), out('portal.log')] });
    pids.portal = portal.pid; portal.unref();
    const health = await until(async () => { const r = await api('GET', '/api/health'); return r.status === 200 && r.json.herdr && r.json.herdr.writes_enabled ? r.json : null; }, 20000);
    step('the portal is up, writes are enabled, history and control are on', health && health.capabilities && health.capabilities.history === 'all' && health.capabilities.control === true, { capabilities: health && health.capabilities, herdr: health && health.herdr && health.herdr.installed_version });
    if (!health) throw new Error('portal did not start: ' + fs.readFileSync(path.join(root, 'portal.log'), 'utf8').slice(-500));
    const run = (pane, text) => cli('pane', 'run', pane, text);
    const readVisible = async (pane) => (await api('GET', `/api/herdr/pane_read?session=${SESSION}&pane_id=${pane}&source=visible`)).json.result.read.text;
    const paneGet = async (pane) => (await api('GET', `/api/herdr/pane_get?session=${SESSION}&pane_id=${pane}`)).json.result.pane;
    const write = (action, pane, extra) => api('POST', `/api/herdr/${action}`, { session: SESSION, pane_id: pane.pane_id, expect_terminal_id: pane.terminal_id, request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
    const fresh = async (p) => ({ ...p, ...(await paneGet(p.pane_id)) });

    // ---- history and host scrollback on a plain shell ----
    run(P1.pane_id, 'seq 1 300; echo end"marker"'); // the quotes keep the typed command line from containing the marker
    await until(async () => (await readVisible(P1.pane_id)).includes('endmarker'));
    let p1 = await fresh(P1);
    const rows = p1.scroll.viewport_rows;
    const hist = await api('GET', `/api/herdr/pane_read?session=${SESSION}&pane_id=${P1.pane_id}&source=recent_unwrapped&lines=2000&expect_terminal_id=${P1.terminal_id}`);
    const text = hist.json && hist.json.result && hist.json.result.read.text || '';
    step('history: a plain shell returns far more than its screen, with the mode and the counts', hist.status === 200 && hist.json.history_mode === 'host_scrollback' && hist.json.lines_returned > rows && /(^|\n)1(\n|$)/.test(text) && text.includes('300') && hist.json.truncated === false, { status: hist.status, mode: hist.json && hist.json.history_mode, viewport_rows: rows, lines_returned: hist.json && hist.json.lines_returned });
    const before = await readVisible(P1.pane_id);
    const up = await write('pane_scroll', p1, { direction: 'up', steps: 2 });
    const mid = await paneGet(P1.pane_id);
    const scrolledText = await readVisible(P1.pane_id);
    step('host scrollback: two steps up moved the real offset by 6 lines and the screen changed', up.status === 200 && up.json.detail.delivered_as === 'host_scrollback' && up.json.detail.scroll_after.offset_from_bottom === 6 && mid.scroll.offset_from_bottom === 6 && scrolledText !== before, { delivered_as: up.json.detail && up.json.detail.delivered_as, offset: mid.scroll.offset_from_bottom });
    const bottom = await write('pane_scroll', p1, { direction: 'bottom' });
    step('pane to bottom: offset 0 and the original screen is back', bottom.status === 200 && (await paneGet(P1.pane_id)).scroll.offset_from_bottom === 0 && (await readVisible(P1.pane_id)) === before, { status: bottom.status });

    // ---- pinned, undocumented socket shape: pane.scroll (B17) ----
    const sc = await sockCall('pane.scroll', { pane_id: P1.pane_id, offset_from_bottom: 5 });
    const big = await sockCall('pane.scroll', { pane_id: P1.pane_id, offset_from_bottom: 99999 });
    const zero = await sockCall('pane.scroll', { pane_id: P1.pane_id, offset_from_bottom: 0 });
    const max = big.result && big.result.pane && big.result.pane.scroll.max_offset_from_bottom;
    step('probe B17: pane.scroll answers pane_info, sets the offset, clamps to the maximum and 0 resets', sc.result && sc.result.type === 'pane_info' && sc.result.pane.scroll.offset_from_bottom === 5 && big.result.pane.scroll.offset_from_bottom === max && max > 0 && zero.result.pane.scroll.offset_from_bottom === 0, { max_offset_from_bottom: max });

    // ---- mouse-reporting app: wheel scroll and an exact-size click, portal detached ----
    run(P2.pane_id, `'${process.execPath}' mouse-app.js`);
    const appUp = await until(async () => fs.existsSync(path.join(root, 'size.log')) && (await readVisible(P2.pane_id)).includes('row 05'));
    const p2 = await fresh(P2);
    step('the mouse app is on the alternate screen: no Herdr scrollback, so the wheel path applies', appUp && p2.scroll.max_offset_from_bottom === 0, { max_offset_from_bottom: p2.scroll && p2.scroll.max_offset_from_bottom });
    const mouseLog = () => (fs.existsSync(path.join(root, 'mouse.log')) ? fs.readFileSync(path.join(root, 'mouse.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).bytes) : []);
    const sizeLog = () => fs.readFileSync(path.join(root, 'size.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const m0 = mouseLog().length;
    const wheel = await write('pane_scroll', p2, { direction: 'up', steps: 3 });
    await sleep(500);
    const wheelEvents = mouseLog().slice(m0).join('').match(/\x1b\[<64;\d+;\d+M/g) || [];
    step('wheel scroll: three steps arrive as three wheel-up reports, with no position claimed and no resize', wheel.status === 200 && wheel.json.detail.delivered_as === 'wheel_events' && wheel.json.detail.resized === false && wheelEvents.length === 3 && !('scroll_after' in wheel.json.detail), { status: wheel.status, events: wheelEvents.length, detail: wheel.json.detail });
    const bottomWheel = await write('pane_scroll', p2, { direction: 'bottom' });
    step('pane to bottom on a wheel pane is refused (422 bottom_unsupported)', bottomWheel.status === 422 && bottomWheel.json.error.code === 'bottom_unsupported', { status: bottomWheel.status });

    const screen = (await readVisible(P2.pane_id)).split('\n');
    const rowIdx = screen.findIndex((l) => l.startsWith('row 05'));
    const m1 = mouseLog().length;
    const click = await write('pane_click', p2, { column: 1, row: rowIdx, expect_text: 'row 05' });
    await sleep(500);
    const got = mouseLog().slice(m1).join('');
    step('click: the exact cell arrives as a mouse press and release, the size was verified and nothing was resized', click.status === 200 && click.json.detail.resized === false && got.includes(`\x1b[<0;2;${rowIdx + 1}M`) && got.includes(`\x1b[<0;2;${rowIdx + 1}m`) && !sizeLog().some((x) => x.resize), { status: click.status, row: rowIdx, resized: click.json.detail && click.json.detail.resized, sizes: sizeLog() });
    const stale = await write('pane_click', p2, { column: 1, row: rowIdx, expect_text: 'row 99' });
    step('a click whose text is not under the cell is refused with the row as it is (409 screen_changed), nothing arrives', stale.status === 409 && stale.json.error.code === 'screen_changed' && stale.json.error.row_text.startsWith('row 05') && mouseLog().slice(m1).join('') === got, { status: stale.status });
    const tty = (await write('pane_click', { ...p2, terminal_id: 'term_deadbeef' }, { column: 1, row: rowIdx, expect_text: 'row 05' }));
    step('a click for another terminal id is refused (409 target_changed)', tty.status === 409 && tty.json.error.code === 'target_changed', { status: tty.status });

    // ---- mixed case: a shell with scrollback, then an alternate-screen app (B18) ----
    run(P1.pane_id, `'${process.execPath}' mouse-app.js`);
    await until(async () => (await paneGet(P1.pane_id)).scroll.max_offset_from_bottom === 0);
    const during = await paneGet(P1.pane_id);
    const duringHist = await api('GET', `/api/herdr/pane_read?session=${SESSION}&pane_id=${P1.pane_id}&source=recent_unwrapped&lines=2000`);
    step('probe B18: while an app owns the alternate screen the max offset is 0 and history says screen only', during.scroll.max_offset_from_bottom === 0 && duringHist.status === 409 && duringHist.json.error.code === 'history_unavailable', { status: duringHist.status });
    cli('pane', 'send-text', P1.pane_id, 'q');
    const after = await until(async () => { const g = await paneGet(P1.pane_id); return g.scroll.max_offset_from_bottom > 0 ? g : null; });
    step('probe B18: when the app exits the shell scrollback is back', !!after, { max_offset_from_bottom: after && after.scroll.max_offset_from_bottom });

    // ---- a fake recognized agent on the main screen: the agent history branch ----
    run(P3.pane_id, 'seq 1 400; echo end"marker"');
    await until(async () => (await readVisible(P3.pane_id)).includes('endmarker'));
    cli('pane', 'report-agent', P3.pane_id, '--source', 'proof', '--agent', 'claude', '--state', 'idle');
    const p3 = await until(async () => { const g = await paneGet(P3.pane_id); return g.agent ? { ...P3, ...g } : null; });
    const ah = await api('GET', `/api/herdr/pane_read?session=${SESSION}&pane_id=${P3.pane_id}&source=recent_unwrapped&lines=2000&expect_terminal_id=${P3.terminal_id}`);
    step('a reported agent that is idle returns the history of its main screen (the alternate-screen agent branch and Herdr paging a real agent are not proven here)', p3 && ah.status === 200 && ['host_scrollback', 'agent_scrollback'].includes(ah.json.history_mode) && ah.json.lines_returned > p3.scroll.viewport_rows, { status: ah.status, mode: ah.json && ah.json.history_mode, lines_returned: ah.json && ah.json.lines_returned });
    if (p3) {
      const sc3 = await write('pane_scroll', p3, { direction: 'up' });
      step('scrolling that agent pane is refused: read its history instead (409 use_history_read)', sc3.status === 409 && sc3.json.error.code === 'use_history_read', { status: sc3.status });
      const ck3 = await write('pane_click', p3, { column: 1, row: 1, expect_text: 'ab' });
      step('clicking it is refused until the owner enables agent clicks (409 agent_click_disabled)', ck3.status === 409 && ck3.json.error.code === 'agent_click_disabled', { status: ck3.status });
      cli('pane', 'release-agent', P3.pane_id, '--source', 'proof', '--agent', 'claude');
    }

    // ---- the existing write round trip, against the same disposable portal ----
    const p4 = await fresh(P4);
    const e2e = spawnSync(process.execPath, [path.join(__dirname, 'e2e.js'), '--base', `http://127.0.0.1:${port}`, '--session', SESSION, '--pane', p4.pane_id, '--terminal', p4.terminal_id], { env: portalEnv, encoding: 'utf8' });
    step('scripts/e2e.js, including its write round trip, passes against the same disposable portal', e2e.status === 0, { exit: e2e.status, failing: (e2e.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5), ...(e2e.status === 0 ? {} : { tail: String(e2e.stdout + e2e.stderr).replace(/\s+$/, '').split('\n').slice(-6) }) });
  } catch (e) {
    step('the proof ran to the end', false, { note: String(e && e.message).slice(0, 300) });
  } finally {
    await stopAll();
  }
  rec.finished_at = new Date().toISOString(); rec.ok = rec.steps.length > 0 && rec.steps.every((s) => s.ok);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(rec, null, 2));
  console.log(rec.ok ? `\nALL ${rec.steps.length} STEPS PASSED on ${rec.herdr}` : '\nFAILED');
  process.exit(rec.ok ? 0 : 1);
})();
