'use strict';
// pane_click through the HTTP API: a click is delivered only if the text the caller saw is still under the cell and
// nothing on the screen could be answered by it. Fake Herdr socket, fake `herdr` executable, fake ps and stty.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { req, setup } = require('./fixtures/harness');

const CONTROL = 'HERDR_PORTAL_ENABLE_CONTROL';
const AGENT_CLICK = 'HERDR_PORTAL_ENABLE_AGENT_CLICK';
const body = (extra = {}) => ({ session: 'default', pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
const clickPost = (c, extra) => req(c.port, 'POST', '/api/herdr/pane_click', { body: body(extra) });
const on = (extra = {}) => ({ env: { [CONTROL]: '1', ...extra } });
const pane = (c, id = 'w1:p1', rows = 47) => { c.herdr.state.scroll[id] = { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: rows }; };
// A 47-row screen with the given rows filled in; every other row blank.
const screen = (c, rows, id = 'w1:p1') => {
  const lines = Array.from({ length: 47 }, (_, i) => rows[i] || '');
  c.herdr.state.reads[id] = { visible: lines.join('\n') };
};
const jsonl = (c, f) => { try { return fs.readFileSync(path.join(c.dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const controllers = (c) => jsonl(c, 'control-calls.jsonl').filter((r) => r.start);
const commandsOf = (c, pid) => jsonl(c, 'control-calls.jsonl').filter((r) => r.pid === pid && r.command).map((r) => r.command);
const mode = (c, cfg) => fs.writeFileSync(path.join(c.dir, 'control-mode.json'), JSON.stringify(cfg));
const visibleReads = (c) => c.herdr.calls.filter((x) => x.method === 'pane.read' && x.params.source === 'visible');
const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const FIXTURE_LOGS = new Set(['control-calls.jsonl', 'tool-calls.jsonl']);
const DIALOG = ['Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];

test('pane_click is 404 action_disabled until the owner sets the control switch, and nothing is spawned', async (t) => {
  const c = await setup(t);
  pane(c); screen(c, { 3: 'build finished' });
  const r = await clickPost(c, { column: 2, row: 3, expect_text: 'build' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'action_disabled');
  assert.equal(controllers(c).length, 0);
});

test('a click on text that is still there sends a mouse down and a mouse up at the same zero-based cell, then releases', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'build finished: npm test passed' });
  const r = await clickPost(c, { column: 20, row: 3, expect_text: 'npm test' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'input_sent');
  assert.deepEqual({ ...r.json.detail, elapsed_ms: undefined }, { delivered_as: 'mouse_click', button: 'left', column: 20, row: 3, resized: false, elapsed_ms: undefined });
  const [ctl] = controllers(c);
  assert.deepEqual(ctl.argv, ['--session', 'default', 'terminal', 'session', 'control', 'term_aa01', '--cols', '64', '--rows', '47']);
  assert.deepEqual(commandsOf(c, ctl.pid), [
    { type: 'terminal.mouse', action: 'down', button: 'left', column: 20, row: 3 },
    { type: 'terminal.mouse', action: 'up', button: 'left', column: 20, row: 3 },
    { type: 'terminal.release' },
  ]);
  assert.equal(visibleReads(c).length, 1, 'the screen is read once, after the size is known, right before delivery');
});

test('the right button, and the corners of the screen', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 0: 'top left', 46: 'bottom row, right edge here' });
  const a = await clickPost(c, { column: 0, row: 0, button: 'right', expect_text: 'top left' });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.deepEqual(commandsOf(c, controllers(c)[0].pid)[0], { type: 'terminal.mouse', action: 'down', button: 'right', column: 0, row: 0 });
  const b = await clickPost(c, { column: 20, row: 46, expect_text: 'right edge' });
  assert.equal(b.status, 200, JSON.stringify(b.json));
});

test('the clicked text never reaches the response, the ledger or the audit log', async (t) => {
  const c = await setup(t, on());
  const secret = 'zzquux-marker-text';
  pane(c); screen(c, { 5: `result ${secret} end` });
  const r = await clickPost(c, { column: 10, row: 5, expect_text: secret });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!JSON.stringify(r.json).includes(secret));
  const files = filesUnder(c.dir).filter((f) => !FIXTURE_LOGS.has(path.basename(f)) && /\.(jsonl?|log)$/.test(f));
  assert.ok(files.some((f) => /ledger/.test(f)) && files.some((f) => /audit/.test(f)), `ledger and audit files found: ${files.join(', ')}`);
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(secret), `${path.basename(f)} holds no clicked text`);
  const line = jsonl({ dir: path.join(c.dir, 'logs') }, 'audit.jsonl').find((l) => l.action === 'herdr.pane_click');
  assert.deepEqual(line.click, { button: 'left', column: 10, row: 5, delivered_as: 'mouse_click' });
});

test('a stale screen: 409 screen_changed carries the row as it is now, and nothing is spawned', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'build finished: npm run passed' });
  const r = await clickPost(c, { column: 20, row: 3, expect_text: 'npm test' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'screen_changed');
  assert.equal(r.json.error.row_text, 'build finished: npm run passed');
  assert.equal(r.json.error.row, 3);
  assert.equal(controllers(c).length, 0);
  const ledger = (await req(c.port, 'GET', '/api/ledger')).json;
  assert.ok(!JSON.stringify(ledger).includes('npm run'), 'a refusal before delivery is not a ledger row');
});

test('a column or row outside the terminal is refused with the real size', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'text here' });
  for (const extra of [{ column: 64, row: 3 }, { column: 2, row: 47 }]) {
    const r = await clickPost(c, { ...extra, expect_text: 'text' });
    assert.equal(r.status, 422, JSON.stringify(extra));
    assert.equal(r.json.error.code, 'out_of_bounds');
    assert.deepEqual([r.json.error.rows, r.json.error.cols], [47, 64]);
  }
  assert.equal(controllers(c).length, 0);
});

test('rows that hold wide, combining or emoji characters are refused with 422 row_not_cell_mappable', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 1: '中文 Save', 2: 'café open', 3: '⏺ Read file' });
  for (const [row, column, text] of [[1, 6, 'Save'], [2, 7, 'open'], [3, 4, 'Read file']]) {
    const r = await clickPost(c, { column, row, expect_text: text });
    assert.equal(r.status, 422, text);
    assert.equal(r.json.error.code, 'row_not_cell_mappable', text);
  }
  assert.equal(controllers(c).length, 0);
});

test('confirm words in the text are 403 escalate_to_owner on every pane, before the screen is even read', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'Allow once   Deny' });
  for (const text of ['Allow once', 'Deny', 'Yes, proceed', 'trust']) {
    const r = await clickPost(c, { column: 1, row: 3, expect_text: text });
    assert.equal(r.status, 403, text);
    assert.equal(r.json.error.code, 'escalate_to_owner', text);
  }
  assert.equal(visibleReads(c).length, 0);
  assert.equal(controllers(c).length, 0);
});

test('the word under the click counts too: a fragment of "Allow" is still the Allow button', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: '[ Allow once ]' });
  const r = await clickPost(c, { column: 5, row: 3, expect_text: 'llo' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, 'escalate_to_owner');
  const ok = await clickPost(c, { column: 3, row: 3, expect_text: 'Allow' });
  assert.equal(ok.status, 403);
});

test('a menu in a format the dialog parser does not know is still refused: its rows are choices or hold a confirm word', async (t) => {
  const ask = ['Apply this change to src/app.js?', '● 1. Allow once', '  2. Allow for this session', '  3. No, suggest changes (esc)'];
  const CASES = [
    ['radio bullet, the option word', { 3: ask[0], 4: ask[1], 5: ask[2], 6: ask[3] }, 11, 4, 'once'],
    ['radio bullet, the option number', { 3: ask[0], 4: ask[1], 5: ask[2], 6: ask[3] }, 2, 4, '1.'],
    ['an ASCII cursor', { 3: 'Run this command?', 4: '> 1. Yes', 5: '  2. No' }, 2, 4, '1.'],
    ['two buttons side by side', { 3: 'Install left-pad and run its postinstall script?', 5: '[ Run ]   [ Skip ]' }, 3, 5, 'Run'],
    ['the closing bracket of an Allow button', { 3: 'Apply the change?', 4: '  [ Allow ]   [ Deny ]' }, 10, 4, 'w ]'],
    ['a number in parentheses, a comma between two confirm words', { 3: 'Run this command?', 4: '  (1) Yes, proceed', 5: '  (2) No, exit' }, 9, 4, ', p'],
    ['a list with a line under it that is not a footer', { 3: 'Make this edit?', 4: ' ❯ 1. Yes, auto-accept edits', 5: '   2. No', 6: ' ctrl-g to edit the plan' }, 3, 4, '1.'],
    ['a menu drawn in a box', { 3: '│ ❯ 1. Run it now │', 4: '│   2. Later       │' }, 8, 4, 'Later'],
    ['one button per row', { 3: '[ Run ]', 4: '[ Skip ]' }, 3, 4, 'Skip'],
    ['buttons one space apart, in parentheses', { 5: '( Run ) ( Skip )' }, 3, 5, 'Run'],
    ['a cursor list without numbers', { 3: ' ❯ Run it now', 5: ' enter to select' }, 6, 3, 'Run it'],
    ['lettered options', { 3: 'a) Run', 4: 'b) Skip' }, 4, 4, 'Skip'],
    ['the description under an entry', { 3: '  1. Run', 4: '     Runs every tool without asking' }, 10, 4, 'every tool'],
    ['a ballot box', { 3: '☐ Install left-pad' }, 4, 3, 'Install'],
    ['a separator between buttons', { 3: '[ Deploy ] | [ Cancel ]' }, 3, 3, 'Deploy'],
    ['a button row cut off at the edge of a narrow pane', { 3: 'Apply the change?', 4: '[ Run ]   [ Skip' }, 3, 4, 'Run'],
    ['a second button with a long label', { 3: '[ Run ]   [ Skip the database migration and the seed step ]' }, 3, 3, 'Run'],
    ['a radio list drawn with circles', { 3: ' ◉ Run it now', 4: ' ○ Do it later' }, 5, 4, 'Do it'],
  ];
  for (const [name, rows, column, row, text] of CASES) {
    const c = await setup(t, on());
    pane(c); screen(c, rows);
    const r = await clickPost(c, { column, row, expect_text: text });
    assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error.code, 'escalate_to_owner', name);
    assert.equal(controllers(c).length, 0, name);
  }
  const c = await setup(t, on());
  pane(c); screen(c, { 3: '[ Settings ]', 4: 'version 1.5 released' });
  assert.equal((await clickPost(c, { column: 3, row: 3, expect_text: 'Settings' })).status, 200, 'one button on a row is an ordinary click');
  assert.equal((await clickPost(c, { column: 8, row: 4, expect_text: '1.5' })).status, 200, 'a number that does not start the row is an ordinary click');
});

test('a row that the dialog refuse list matches is 403 escalate_to_owner (a delete, a sudo, a credential)', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'run: rm -rf build/cache', 4: 'keychain entry list' });
  const a = await clickPost(c, { column: 8, row: 3, expect_text: 'rm -rf' });
  assert.equal(a.status, 403, JSON.stringify(a.json)); assert.equal(a.json.error.code, 'escalate_to_owner');
  const b = await clickPost(c, { column: 5, row: 4, expect_text: 'chain' });
  assert.equal(b.status, 403, JSON.stringify(b.json));
  assert.equal(controllers(c).length, 0);
});

test('a dialog on the screen: 409 dialog_on_screen, nothing is sent, whatever the click targets', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 10: DIALOG[0], 11: DIALOG[1], 12: DIALOG[2], 2: 'some other line' });
  const r = await clickPost(c, { column: 3, row: 2, expect_text: 'other line' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'dialog_on_screen');
  assert.equal(controllers(c).length, 0);
});

test('expect_text must carry at least two non-space characters and at most 120', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'a b c' });
  for (const text of ['a', '  a  ', ' ', '', 'x'.repeat(121)]) {
    const r = await clickPost(c, { column: 0, row: 3, expect_text: text });
    assert.equal(r.status, 400, JSON.stringify(text.slice(0, 8)));
    assert.equal(r.json.error.code, 'invalid_param');
  }
  const missing = await req(c.port, 'POST', '/api/herdr/pane_click', { body: (() => { const b = body({ column: 0, row: 3 }); return b; })() });
  assert.equal(missing.json.error.code, 'missing_param');
});

test('agent panes need the third switch, and then only an idle or done agent is clicked', async (t) => {
  const off = await setup(t, on());
  pane(off, 'w1:p2'); screen(off, { 3: 'Search results here' }, 'w1:p2');
  const agent = { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', column: 9, row: 3, expect_text: 'results' };
  const refused = await clickPost(off, agent);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'agent_click_disabled');
  assert.match(refused.json.error.message, /HERDR_PORTAL_ENABLE_AGENT_CLICK=1/);
  assert.equal(controllers(off).length, 0);

  const c = await setup(t, on({ [AGENT_CLICK]: '1' }));
  pane(c, 'w1:p2'); screen(c, { 3: 'Search results here' }, 'w1:p2');
  for (const status of ['idle', 'done']) {
    c.herdr.state.panes['w1:p2'].agent_status = status;
    { const r = await clickPost(c, agent); assert.equal(r.status, 200, status + JSON.stringify(r.json)); }
  }
  const before = controllers(c).length;
  for (const [status, code] of [['working', 'agent_state_not_writable'], ['unknown', 'agent_state_not_writable'], ['blocked', 'blocked_requires_decision']]) {
    c.herdr.state.panes['w1:p2'].agent_status = status;
    const r = await clickPost(c, agent);
    assert.equal(r.status, 409, status);
    assert.equal(r.json.error.code, code, status);
  }
  assert.equal(controllers(c).length, before, 'a busy agent is never clicked');
});

test('a mistyped agent-click value never lets an agent pane be clicked, and only the exact value does', async (t) => {
  const agent = { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', column: 9, row: 3, expect_text: 'results' };
  for (const value of ['true', 'false', 'off', 'no', '2']) {
    const c = await setup(t, on({ [AGENT_CLICK]: value }));
    pane(c, 'w1:p2'); screen(c, { 3: 'Search results here' }, 'w1:p2');
    assert.equal((await req(c.port, 'GET', '/api/health')).json.capabilities.agent_click, 'invalid', value);
    const r = await clickPost(c, agent);
    assert.equal(r.status, 409, value);
    assert.equal(r.json.error.code, 'agent_click_disabled', value);
    assert.equal(controllers(c).length, 0, value + ' sends nothing');
  }
  const c = await setup(t, on({ [AGENT_CLICK]: '1' }));
  pane(c, 'w1:p2'); screen(c, { 3: 'Search results here' }, 'w1:p2');
  assert.equal((await clickPost(c, agent)).status, 200);
});

test('the agent-click switch does nothing without the control switch, and health reports the effective values', async (t) => {
  const only = await setup(t, { env: { [AGENT_CLICK]: '1' } });
  assert.equal((await req(only.port, 'GET', '/api/health')).json.capabilities.agent_click, false);
  const both = await setup(t, on({ [AGENT_CLICK]: '1' }));
  assert.equal((await req(both.port, 'GET', '/api/health')).json.capabilities.agent_click, true);
  assert.equal((await req(both.port, 'GET', '/api/health')).json.capabilities.control, true);
});

test('the same idempotency key replays the stored answer and clicks once', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'build finished' });
  const b = body({ column: 2, row: 3, expect_text: 'build' });
  const a = await req(c.port, 'POST', '/api/herdr/pane_click', { body: b });
  const again = await req(c.port, 'POST', '/api/herdr/pane_click', { body: b });
  assert.equal(a.status, 200); assert.equal(again.status, 200);
  assert.equal(again.json.replayed, true);
  assert.equal(controllers(c).length, 1);
});

test('a busy terminal is a definite failure, never a click', async (t) => {
  const c = await setup(t, on());
  pane(c); screen(c, { 3: 'build finished' });
  mode(c, { mode: 'busy' });
  const r = await clickPost(c, { column: 2, row: 3, expect_text: 'build' });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.error, 'controller_busy');
});

test('without a verified size nothing is read from the screen or sent', async (t) => {
  const c = await setup(t, on());
  screen(c, { 3: 'build finished' });
  const r = await clickPost(c, { column: 2, row: 3, expect_text: 'build' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'size_unverified');
  assert.equal(controllers(c).length, 0);
});
