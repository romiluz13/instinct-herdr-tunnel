'use strict';
// History reads (pane_read sources recent and recent_unwrapped) through the HTTP API against a fake Herdr.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { req, setup } = require('./fixtures/harness');

const H = 'HERDR_PORTAL_ENABLE_HISTORY';
const chat = (n) => Array.from({ length: n }, (_, i) => `chat line ${i + 1}`).join('\n');
const scroll = (max, rows = 40) => ({ offset_from_bottom: 0, max_offset_from_bottom: max, viewport_rows: rows });
const read = (c, pane, extra = '') => req(c.port, 'GET', `/api/herdr/pane_read?session=default&pane_id=${pane}&source=recent_unwrapped${extra}`);
const historyReads = (c) => c.herdr.calls.filter((x) => x.method === 'pane.read' && /^recent/.test(x.params.source));
// w1:p1 plain shell (agent null), w1:p2 claude idle, w1:p3 codex blocked
const prime = (c, pane, { text, rows = 40, max = 0, source = 'recent_unwrapped' }) => {
  c.herdr.state.scroll[pane] = scroll(max, rows);
  c.herdr.state.reads[pane] = { [source]: text };
};

test('history sources are refused while the owner has not enabled them, and nothing reaches Herdr', async (t) => {
  const c = await setup(t);
  for (const source of ['recent', 'recent_unwrapped']) {
    const r = await req(c.port, 'GET', `/api/herdr/pane_read?session=default&pane_id=w1:p2&source=${source}`);
    assert.equal(r.status, 403, source);
    assert.equal(r.json.error.code, 'source_disabled');
    assert.match(r.json.error.message, /HERDR_PORTAL_ENABLE_HISTORY/);
  }
  assert.equal((await req(c.port, 'GET', '/api/herdr/pane_read?session=default&pane_id=w1:p2&source=recent-unwrapped')).status, 400, 'the CLI spelling is not a socket source');
  assert.equal(historyReads(c).length, 0);
});

test('HISTORY=agents: an idle recognized agent returns its whole transcript with the mode, the line count and the truncation flag', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  prime(c, 'w1:p2', { text: chat(120) });
  const r = await read(c, 'w1:p2', '&lines=2000&expect_terminal_id=term_aa02');
  assert.equal(r.status, 200);
  assert.equal(r.json.history_mode, 'agent_scrollback');
  assert.equal(r.json.lines_returned, 120);
  assert.equal(r.json.truncated, false);
  assert.equal(r.json.source, 'recent_unwrapped');
  assert.equal(r.json.checked_terminal_id, 'term_aa02');
  assert.equal(r.json.result.read.text, chat(120));
  assert.deepEqual(historyReads(c).map((x) => x.params), [{ pane_id: 'w1:p2', source: 'recent_unwrapped', format: 'text', strip_ansi: true, lines: 2000 }]);
  const plain = await read(c, 'w1:p1');
  assert.equal(plain.status, 403);
  assert.equal(plain.json.error.code, 'source_disabled');
  assert.match(plain.json.error.message, /HERDR_PORTAL_ENABLE_HISTORY=all/, 'a plain pane needs the wider setting');
  assert.equal(historyReads(c).length, 1, 'the plain pane was never read');
});

test('HISTORY=1 means agents only', async (t) => {
  const c = await setup(t, { env: { [H]: '1' } });
  prime(c, 'w1:p2', { text: chat(80) });
  assert.equal((await read(c, 'w1:p2')).status, 200);
  assert.equal((await read(c, 'w1:p1')).status, 403);
});

test('a working, blocked or unknown agent is not read; idle and done are', async (t) => {
  const c = await setup(t, { env: { [H]: 'all' } });
  prime(c, 'w1:p2', { text: chat(90) });
  for (const status of ['working', 'blocked', 'unknown']) {
    c.herdr.state.panes['w1:p2'].agent_status = status;
    const r = await read(c, 'w1:p2');
    assert.equal(r.status, 409, status);
    assert.equal(r.json.error.code, 'history_requires_idle');
    assert.equal(r.json.error.agent_status, status);
  }
  assert.equal(historyReads(c).length, 0, 'Herdr is never asked to page a busy agent');
  for (const status of ['idle', 'done']) {
    c.herdr.state.panes['w1:p2'].agent_status = status;
    assert.equal((await read(c, 'w1:p2')).status, 200, status);
  }
});

test('HISTORY=all: a plain pane reports host scrollback; a pane with nothing beyond the screen says so instead of passing the screen off as history', async (t) => {
  const c = await setup(t, { env: { [H]: 'all' } });
  prime(c, 'w1:p1', { text: chat(130), max: 90 });
  const ok = await read(c, 'w1:p1', '&lines=200');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.history_mode, 'host_scrollback');
  assert.equal(ok.json.lines_returned, 130);

  prime(c, 'w1:p1', { text: chat(30), max: 0 });
  const small = await read(c, 'w1:p1', '&lines=30');
  assert.equal(small.status, 200, 'asking for no more than the screen is fine');
  assert.equal(small.json.history_mode, 'screen_only');
  const big = await read(c, 'w1:p1', '&lines=2000');
  assert.equal(big.status, 409);
  assert.equal(big.json.error.code, 'history_unavailable');
  assert.equal(big.json.error.history_mode, 'screen_only');
  assert.equal(big.json.error.viewport_rows, 40);
  assert.equal(big.json.error.visible_text, chat(30), 'nothing is lost: the screen comes back in the error');
});

test('a short transcript of a recognized agent is screen only too', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  prime(c, 'w1:p2', { text: chat(12) });
  const r = await read(c, 'w1:p2', '&lines=500');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'history_unavailable');
});

test('without scroll metrics from Herdr the mode is reported unknown and nothing is refused on a guess', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  c.herdr.state.reads['w1:p2'] = { recent_unwrapped: chat(60) };
  const r = await read(c, 'w1:p2');
  assert.equal(r.status, 200);
  assert.equal(r.json.history_mode, 'unknown');
});

test('history text is capped at 262,144 characters from the end and flagged truncated; Herdr\'s own truncation flag is passed on', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  const big = ('x'.repeat(99) + '\n').repeat(3000);
  prime(c, 'w1:p2', { text: big });
  const r = await read(c, 'w1:p2', '&lines=2000');
  assert.equal(r.status, 200);
  assert.equal(r.json.result.read.text.length, 262144);
  assert.equal(r.json.result.read.text, big.slice(-262144));
  assert.equal(r.json.truncated, true);
  prime(c, 'w1:p2', { text: ('é'.repeat(99) + '\n').repeat(3000) });
  assert.equal((await read(c, 'w1:p2', '&lines=2000')).json.result.read.text.length, 262144, 'characters, not bytes');
  prime(c, 'w1:p2', { text: chat(100) });
  c.herdr.state.readTruncated['w1:p2'] = true;
  assert.equal((await read(c, 'w1:p2')).json.truncated, true, 'Herdr said it cut the history');
});

test('a screen read cannot ask for more than 500 lines: that is what the history switch is for', async (t) => {
  const c = await setup(t);
  for (const source of ['visible', 'detection']) {
    const r = await req(c.port, 'GET', `/api/herdr/pane_read?session=default&pane_id=w1:p1&source=${source}&lines=2000`);
    assert.equal(r.status, 400, source);
    assert.equal(r.json.error.code, 'invalid_param');
  }
  assert.equal((await req(c.port, 'GET', '/api/herdr/pane_read?session=default&pane_id=w1:p1&source=visible&lines=500')).status, 200);
});

test('every history read leaves an audit line with the source and the size, never the text; a screen read leaves none', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  prime(c, 'w1:p2', { text: chat(60), max: 100 });
  const mark = chat(60).split('\n')[7];
  await read(c, 'w1:p2', '&lines=50');
  await req(c.port, 'GET', '/api/herdr/pane_read?session=default&pane_id=w1:p2&source=visible');
  await read(c, 'w1:p1');
  const lines = fs.readFileSync(path.join(c.dir, 'logs', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.action === 'herdr.pane_read');
  assert.equal(lines.length, 2, 'the history read and the refused one, not the screen read');
  assert.deepEqual(lines[0].history, { mode: 'host_scrollback', lines_requested: 50, lines_returned: 60, truncated: false });
  assert.equal(lines[0].pane, 'w1:p2'); assert.equal(lines[0].source, 'recent_unwrapped'); assert.equal(lines[0].result, 'read');
  assert.equal(lines[1].result, 'rejected'); assert.equal(lines[1].error_code, 'source_disabled'); assert.equal(lines[1].history, null);
  assert.ok(!JSON.stringify(lines).includes(mark), 'no text of the chat');
});

test('a history read is refused when the audit log cannot be written, also the first one to find it unwritable, and nothing is returned', async (t) => {
  const { dispatch } = require('../lib/actions');
  const fake = require('./fixtures/fake-herdr-server');
  const dir = fs.mkdtempSync('/tmp/hp-');
  const herdr = await fake.start(path.join(dir, 'herdr.sock'));
  t.after(async () => { await herdr.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  herdr.state.scroll['w1:p1'] = { offset_from_bottom: 0, max_offset_from_bottom: 30, viewport_rows: 40 };
  herdr.state.reads['w1:p1'] = { recent: 'scrollback line 1\nscrollback line 2', visible: 'screen row' };
  const before = process.env[H]; process.env[H] = 'all';
  t.after(() => { if (before === undefined) delete process.env[H]; else process.env[H] = before; });
  const audit = { healthy: true, append() { this.healthy = false; throw new Error('ENOSPC'); } };
  const ctx = { audit, inventory: { session: () => ({ running: true, socket_path: path.join(dir, 'herdr.sock') }) }, waits: 0 };
  const history = { session: 'default', pane_id: 'w1:p1', source: 'recent' };
  const stderr = process.stderr.write; process.stderr.write = () => true;
  try {
    await assert.rejects(dispatch(ctx, 'herdr.pane_read', 'GET', history), (e) => e.status === 503 && e.code === 'audit_unavailable', 'the read that finds the log unwritable is not returned');
    assert.equal(audit.healthy, false);
    const reads = herdr.calls.filter((x) => x.method === 'pane.read').length;
    await assert.rejects(dispatch(ctx, 'herdr.pane_read', 'GET', history), (e) => e.status === 503 && e.code === 'audit_unavailable');
    assert.equal(herdr.calls.filter((x) => x.method === 'pane.read').length, reads, 'once the log is known to be unwritable the pane is not read at all');
    const screen = await dispatch(ctx, 'herdr.pane_read', 'GET', { session: 'default', pane_id: 'w1:p1', source: 'visible' });
    assert.equal(screen.result.read.text, 'screen row', 'a screen read leaves no line, so it still answers');
  } finally { process.stderr.write = stderr; }
});

test('a slow agent history read ends in 504 history_timeout that says the agent may still be scrolling', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents', HERDR_PORTAL_HISTORY_TIMEOUT_MS: '300' } });
  prime(c, 'w1:p2', { text: chat(90) });
  c.herdr.state.delayMs['pane.read'] = 1500;
  const r = await read(c, 'w1:p2');
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'history_timeout');
  assert.match(r.json.error.message, /may still be scrolling/);
  assert.match(r.json.error.message, /read visible/);
});

test('history reads of one agent pane run one at a time; plain panes are passive and overlap', async (t) => {
  const c = await setup(t, { env: { [H]: 'all' } });
  prime(c, 'w1:p2', { text: chat(90) });
  prime(c, 'w1:p1', { text: chat(90), max: 60 });
  c.herdr.state.delayMs['pane.read'] = 400;
  const [a, b] = await Promise.all([read(c, 'w1:p2'), read(c, 'w1:p2')]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const agent = historyReads(c).filter((x) => x.params.pane_id === 'w1:p2').map((x) => x.at);
  assert.equal(agent.length, 2);
  assert.ok(agent[1] - agent[0] >= 350, `second read started ${agent[1] - agent[0]} ms after the first: it waited for the lock`);

  const before = historyReads(c).length;
  const [x, y] = await Promise.all([read(c, 'w1:p1'), read(c, 'w1:p1')]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  const plain = historyReads(c).slice(before).map((r) => r.at);
  assert.ok(plain[1] - plain[0] < 250, 'plain pane reads are not serialized');
});

test('a status that changes while the read waits for the lock is seen: the second read is refused if the agent went busy', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  prime(c, 'w1:p2', { text: chat(90) });
  c.herdr.state.delayMs['pane.read'] = 500;
  const first = read(c, 'w1:p2');
  await new Promise((r) => setTimeout(r, 150));
  const second = read(c, 'w1:p2');
  await new Promise((r) => setTimeout(r, 150));
  c.herdr.state.panes['w1:p2'].agent_status = 'working';
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(b.json.error.code, 'history_requires_idle');
  assert.equal(historyReads(c).length, 1);
});

test('a terminal that changed is refused before any history is read', async (t) => {
  const c = await setup(t, { env: { [H]: 'agents' } });
  prime(c, 'w1:p2', { text: chat(90) });
  const r = await read(c, 'w1:p2', '&expect_terminal_id=term_aa99');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'target_changed');
  assert.equal(historyReads(c).length, 0);
});
