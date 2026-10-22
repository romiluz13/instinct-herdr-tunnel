'use strict';
// pane_scroll through the HTTP API: the wheel-event path (a pane with no host scrollback) via the Herdr terminal
// controller, with a fake `herdr` executable, fake ps and stty, and a fake Herdr socket server.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { req, setup } = require('./fixtures/harness');

const CONTROL = 'HERDR_PORTAL_ENABLE_CONTROL';
const STTY_FLAG = process.platform === 'darwin' ? '-f' : '-F';
const body = (extra = {}) => ({ session: 'default', pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
const scrollPost = (c, extra) => req(c.port, 'POST', '/api/herdr/pane_scroll', { body: body(extra) });
const on = (extra = {}) => ({ env: { [CONTROL]: '1', ...extra } });
const wheelPane = (c, id = 'w1:p1', rows = 47) => { c.herdr.state.scroll[id] = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: rows }; };
const mode = (c, cfg) => fs.writeFileSync(path.join(c.dir, 'control-mode.json'), JSON.stringify(cfg));
const jsonl = (c, f) => { try { return fs.readFileSync(path.join(c.dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const controllers = (c) => jsonl(c, 'control-calls.jsonl').filter((r) => r.start);
const commandsOf = (c, pid) => jsonl(c, 'control-calls.jsonl').filter((r) => r.pid === pid && r.command).map((r) => r.command);
const setJson = (c, f, v) => fs.writeFileSync(path.join(c.dir, f), JSON.stringify(v));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('pane_scroll is 404 action_disabled until the owner sets the control switch, and nothing is spawned', async (t) => {
  const c = await setup(t);
  wheelPane(c);
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'action_disabled');
  assert.match(r.json.error.message, /HERDR_PORTAL_ENABLE_CONTROL=1/);
  assert.equal(controllers(c).length, 0);
});

test('wheel scroll: the real size comes from the pane\'s tty, one controller runs at exactly that size, one wheel command per step, no resize, no takeover', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  const r = await scrollPost(c, { direction: 'up', steps: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'input_sent');
  assert.equal(r.json.detail.delivered_as, 'wheel_events');
  assert.equal(r.json.detail.steps, 2);
  assert.ok(!('scroll_after' in r.json.detail) && !('scroll_before' in r.json.detail), 'no position is claimed for wheel events');
  const [ctl] = controllers(c);
  assert.deepEqual(ctl.argv, ['--session', 'default', 'terminal', 'session', 'control', 'term_aa01', '--cols', '64', '--rows', '47']);
  assert.ok(!ctl.argv.includes('--takeover'));
  assert.deepEqual(commandsOf(c, ctl.pid), [
    { type: 'terminal.scroll', direction: 'up', lines: 3 }, { type: 'terminal.scroll', direction: 'up', lines: 3 }, { type: 'terminal.release' },
  ]);
  const tools = jsonl(c, 'tool-calls.jsonl');
  assert.ok(tools.some((x) => x.tool === 'ps' && x.args.join(' ') === '-o tty= -p 4101'), 'ps by argument array');
  assert.ok(tools.some((x) => x.tool === 'stty' && x.args.join(' ') === `${STTY_FLAG} /dev/ttys001 size`), 'stty on the pane\'s tty');
  const audit = jsonl({ dir: path.join(c.dir, 'logs') }, 'audit.jsonl').find((l) => l.action === 'herdr.pane_scroll');
  assert.deepEqual(audit.scroll, { direction: 'up', steps: 2, delivered_as: 'wheel_events' });
});

test('wheel scroll refuses a pane that shows a dialog, and sends nothing', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  c.herdr.state.reads['w1:p1'] = { visible: ['Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n') };
  const r = await scrollPost(c, { direction: 'down', steps: 2 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'dialog_on_screen');
  assert.match(r.json.error.message, /scrolls nothing/);
  assert.equal(controllers(c).length, 0);
});

test('direction down with the default of one step', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  const r = await scrollPost(c, { direction: 'down' });
  assert.equal(r.status, 200);
  assert.deepEqual(commandsOf(c, controllers(c)[0].pid), [{ type: 'terminal.scroll', direction: 'down', lines: 3 }, { type: 'terminal.release' }]);
});

test('"bottom" cannot be promised for wheel events: 422 bottom_unsupported before anything is spawned', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  const r = await scrollPost(c, { direction: 'bottom' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'bottom_unsupported');
  assert.equal(controllers(c).length, 0);
});

test('a pane hosting a recognized agent is refused: scroll would disable its history reads', async (t) => {
  const c = await setup(t, on());
  wheelPane(c, 'w1:p2');
  const idle = await scrollPost(c, { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', direction: 'up' });
  assert.equal(idle.status, 409);
  assert.equal(idle.json.error.code, 'use_history_read');
  const blocked = await scrollPost(c, { pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', direction: 'up' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'blocked_requires_decision');
  c.herdr.state.panes['w1:p2'].agent_status = 'unknown';
  const unknown = await scrollPost(c, { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', direction: 'up' });
  assert.equal(unknown.status, 409);
  assert.equal(unknown.json.error.code, 'agent_state_not_writable');
  assert.equal(controllers(c).length, 0);
});

test('size_unverified: nothing is sent when the real size cannot be confirmed against what Herdr reports', async (t) => {
  const c = await setup(t, on());
  const refused = async (label, message) => {
    const r = await scrollPost(c, { direction: 'up' });
    assert.equal(r.status, 409, label); assert.equal(r.json.error.code, 'size_unverified', label);
    if (message) assert.match(r.json.error.message, message, label);
    assert.equal(controllers(c).length, 0, label);
  };
  await refused('no scroll metrics from Herdr');
  wheelPane(c);
  fs.writeFileSync(path.join(c.dir, 'stty-size.txt'), '40 64'); await refused('rows differ from viewport_rows');
  fs.rmSync(path.join(c.dir, 'stty-size.txt'));
  setJson(c, 'ps.json', { 4101: '??' }); await refused('the pane has no terminal device');
  setJson(c, 'ps.json', { 4101: 'FAIL' }); await refused('ps fails', /ps failed \(exit 1\)/);
  setJson(c, 'ps.json', {}); setJson(c, 'stty-fail.json', true); await refused('stty fails', /stty failed \(exit 1\)/);
  setJson(c, 'stty-fail.json', false);
  c.herdr.state.pids['w1:p1'] = { shell: 4101, fg: 4102 }; setJson(c, 'ps.json', { 4102: 'ttys002' }); await refused('the foreground process is on another terminal');
  setJson(c, 'ps.json', {}); c.herdr.state.pids['w1:p1'] = undefined;
  assert.equal((await scrollPost(c, { direction: 'up' })).status, 200, 'and with everything agreeing it goes through');
});

test('a ps or stty that outlives its timeout is size_unverified (timed out), and nothing is sent', async (t) => {
  const c = await setup(t, on({ HERDR_PORTAL_SIZE_TOOL_TIMEOUT_MS: '300' }));
  wheelPane(c);
  setJson(c, 'tool-delay.json', 3000);
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'size_unverified');
  assert.match(r.json.error.message, /timed out/);
  assert.equal(controllers(c).length, 0);
});

test('a tty named by Herdr is used directly and still cross-checked against the foreground process', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  c.herdr.state.tty['w1:p1'] = '/dev/ttys009';
  setJson(c, 'ps.json', { 4101: 'ttys009' });
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(jsonl(c, 'tool-calls.jsonl').some((x) => x.tool === 'stty' && x.args.join(' ') === `${STTY_FLAG} /dev/ttys009 size`));
  setJson(c, 'ps.json', { 4101: 'ttys001' });
  const mismatch = await scrollPost(c, { direction: 'up' });
  assert.equal(mismatch.json.error.code, 'size_unverified');
});

test('controller outcomes come from the order of the records: busy and refused are definite failures, anything doubtful is needs_review', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  const run = async (cfg) => { mode(c, cfg); return scrollPost(c, { direction: 'up' }); };

  const busy = await run({ mode: 'busy' });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.status, 'failed'); assert.equal(busy.json.detail.error, 'controller_busy');
  assert.equal(commandsOf(c, controllers(c)[0].pid).length, 0, 'the busy controller was given nothing it could act on');

  const refused = await run({ mode: 'busy', reason: 'terminal attach failed: terminal term_aa01 is not available' });
  assert.equal(refused.status, 502);
  assert.equal(refused.json.status, 'failed'); assert.equal(refused.json.detail.error, 'controller_refused');

  const unknown = await run({ mode: 'busy', reason: 'stream closed: server shutting down' });
  assert.equal(unknown.status, 502, 'a close that does not say the attach failed may follow consumed commands');
  assert.equal(unknown.json.status, 'needs_review');

  const reattach = await run({ mode: 'busy', reason: 'controller lost: reattach failed after server restart' });
  assert.equal(reattach.json.status, 'needs_review', 'the attach wording must open the reason, not sit anywhere inside it');

  const quiet = await run({ mode: 'detached-no-frame' });
  assert.equal(quiet.status, 200, 'Herdr sends a frame only when the screen changes: detached and exit 0 is delivery, frame or not');
  assert.equal(quiet.json.status, 'input_sent');

  for (const m of ['early-exit', 'malformed', 'no-closed', 'exit-now']) {
    const r = await run({ mode: m });
    assert.equal(r.status, 502, m);
    assert.equal(r.json.status, 'needs_review', m);
    assert.match(JSON.stringify(r.json.detail), /Inspect the pane/, m);
  }
  assert.equal((await req(c.port, 'GET', '/api/health')).status, 200, 'the portal survived a controller that closed its stdin');
  assert.equal((await run({ mode: 'ok' })).json.status, 'input_sent');
});

test('a pane whose size changed during the call is needs_review with resized, never input_sent', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  mode(c, { mode: 'resize', newSize: '30 100' });
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 502);
  assert.equal(r.json.status, 'needs_review');
  assert.equal(r.json.detail.resized, true);
});

test('a controller whose child keeps the output open is released at the hard stop as needs_review, and the pane lock is free again', async (t) => {
  const c = await setup(t, on({ HERDR_PORTAL_CONTROLLER_LIFETIME_MS: '300', HERDR_PORTAL_CONTROLLER_KILL_GRACE_MS: '300' }));
  let grandchild = null; // read while the harness directory still exists, killed by exact pid when the test ends
  t.after(() => { if (grandchild) try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } });
  wheelPane(c);
  mode(c, { mode: 'grandchild' });
  const t0 = Date.now();
  const r = await scrollPost(c, { direction: 'up' });
  grandchild = Number(fs.readFileSync(path.join(c.dir, 'grandchild.pid'), 'utf8'));
  assert.equal(r.json.status, 'needs_review', JSON.stringify(r.json));
  assert.ok(Date.now() - t0 < 10000, 'the portal did not wait for the child that held the pipe');
  mode(c, { mode: 'ok' });
  assert.equal((await scrollPost(c, { direction: 'up' })).json.status, 'input_sent', 'the pane lock was released');
});

test('a controller that outlives its deadline is stopped with SIGTERM, then SIGKILL on the exact pid, and the result is needs_review', async (t) => {
  const c = await setup(t, on({ HERDR_PORTAL_CONTROLLER_LIFETIME_MS: '400', HERDR_PORTAL_CONTROLLER_KILL_GRACE_MS: '300' }));
  wheelPane(c);
  mode(c, { mode: 'hang', ignoreTerm: true });
  const t0 = Date.now();
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 502);
  assert.equal(r.json.status, 'needs_review');
  assert.equal(r.json.detail.killed, true);
  assert.match(r.json.detail.note, /mouse button may still be pressed/);
  assert.ok(Date.now() - t0 >= 650, 'SIGTERM at the deadline, SIGKILL after the grace');
  const [ctl] = controllers(c);
  assert.ok(jsonl(c, 'control-calls.jsonl').some((x) => x.pid === ctl.pid && x.sigterm), 'it was asked to stop first');
  assert.equal(alive(ctl.pid), false, 'and killed');
});

test('the pane lock is held until the controller has closed; the next request starts after it', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  mode(c, { mode: 'ok', holdMs: 500 });
  const [a, b] = await Promise.all([scrollPost(c, { direction: 'up' }), scrollPost(c, { direction: 'down' })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const events = jsonl(c, 'control-calls.jsonl').filter((r) => r.start || r.exit);
  assert.deepEqual(events.map((e) => (e.start ? 'start' : 'exit')), ['start', 'exit', 'start', 'exit'], 'never two controllers on one pane');
});

test('a status change queued behind the lock is seen by the second request', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  mode(c, { mode: 'ok', holdMs: 600 });
  const first = scrollPost(c, { direction: 'up' });
  await new Promise((r) => setTimeout(r, 150));
  const second = scrollPost(c, { direction: 'up' });
  await new Promise((r) => setTimeout(r, 150));
  Object.assign(c.herdr.state.panes['w1:p1'], { agent: 'codex', agent_status: 'idle' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(b.json.error.code, 'use_history_read');
  assert.equal(controllers(c).length, 1);
});

test('at most four controllers run at once; the fifth is a definite 429', async (t) => {
  const c = await setup(t, on());
  const ids = ['w1:p1', 'w1:p4', 'w1:p5', 'w1:p6', 'w1:p7'];
  ids.slice(1).forEach((id, i) => { c.herdr.state.panes[id] = { pane_id: id, terminal_id: 'term_bb0' + (i + 4), workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/x', agent: null, agent_status: 'unknown', focused: false }; });
  ids.forEach((id) => wheelPane(c, id));
  mode(c, { mode: 'ok', holdMs: 1500 });
  const results = await Promise.all(ids.map((id, i) => scrollPost(c, { pane_id: id, expect_terminal_id: i === 0 ? 'term_aa01' : 'term_bb0' + (i + 3), direction: 'up' })));
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 200, 200, 429]);
  const over = results.find((r) => r.status === 429);
  assert.equal(over.json.status, 'failed'); assert.equal(over.json.detail.error, 'too_many_controllers');
});

test('the same idempotency key replays the stored result and starts no second controller', async (t) => {
  const c = await setup(t, on());
  wheelPane(c);
  const b = body({ direction: 'up' });
  const one = await req(c.port, 'POST', '/api/herdr/pane_scroll', { body: b });
  const two = await req(c.port, 'POST', '/api/herdr/pane_scroll', { body: { ...b, request_id: 'req-' + crypto.randomUUID() } });
  assert.equal(one.status, 200); assert.equal(two.json.replayed, true);
  assert.equal(controllers(c).length, 1);
});
