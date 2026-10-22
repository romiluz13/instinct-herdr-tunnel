'use strict';
// The browser page (public/app.js and viewer.js) run against a real portal and a fake Herdr, in a small DOM with fake
// timers (tests/fixtures/mini-dom.js). Layout is set by the tests; what is checked is behaviour, not pixels.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOKEN, setup } = require('./fixtures/harness');
const { loadPage } = require('./fixtures/mini-dom');

const HISTORY = 'HERDR_PORTAL_ENABLE_HISTORY';
const CONTROL = 'HERDR_PORTAL_ENABLE_CONTROL';
const AGENT_CLICK = 'HERDR_PORTAL_ENABLE_AGENT_CLICK';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (n) => Array.from({ length: n }, (_, i) => `chat line ${i + 1}`).join('\n');
const metrics = (rows, max = 0, offset = 0) => ({ offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: rows });

async function open(t, { env, prepare } = {}) {
  const c = await setup(t, env ? { env } : undefined);
  if (prepare) prepare(c);
  const page = loadPage({ port: c.port });
  page.$('token').value = TOKEN;
  page.fire(page.$('login-form'), 'submit');
  await page.settle();
  return { c, page };
}
const treeButton = (page, id) => page.all('button.pane-btn').find((b) => b.textContent.includes(id));
async function select(page, id) { treeButton(page, id).click(); await page.settle(); }
const reads = (page, source) => page.requests.filter((r) => r.path.startsWith('/api/herdr/pane_read') && r.path.includes(`source=${source}`));
const posts = (page, action) => page.requests.filter((r) => r.method === 'POST' && r.path === `/api/herdr/${action}`);
const status = (page) => page.find('.viewer-status');
const shown = (el) => !el.hidden;

test('the page loads the real index.html, signs in and lists the panes', async (t) => {
  const { page } = await open(t);
  assert.equal(page.$('app').hidden, false);
  assert.ok(treeButton(page, 'w1:p1') && treeButton(page, 'w1:p2') && treeButton(page, 'w1:p3'));
});

test('selecting a pane builds the viewer: the live screen, a status line, and no live region on the terminal text', async (t) => {
  const { page } = await open(t);
  await select(page, 'w1:p1');
  const pre = page.find('pre.term');
  assert.equal(pre.textContent, 'hello from visible');
  assert.equal(pre.getAttribute('aria-label'), 'Pane output');
  assert.equal(pre.getAttribute('tabindex'), '0');
  assert.equal(status(page).getAttribute('role'), 'status');
  assert.equal(page.$('detail').hasAttribute('aria-live'), false, 'the detail wrapper has no live region');
  assert.equal(page.all('[aria-live]').length, 0);
  assert.ok(status(page).textContent.startsWith('Screen'));
});

test('on a narrow screen choosing a pane brings the viewer into view; on a wide one the page stays put', async (t) => {
  const { page } = await open(t);
  let scrolled = 0; let query = '';
  page.$('detail').scrollIntoView = () => { scrolled += 1; };
  await select(page, 'w1:p1');
  assert.equal(scrolled, 0, 'a browser without matchMedia is left alone');
  page.win.matchMedia = (q) => { query = q; return { matches: true }; };
  await select(page, 'w1:p2');
  assert.equal(scrolled, 1);
  assert.equal(query, '(max-width:1000px)', 'the same breakpoint as the stylesheet');
  page.win.matchMedia = () => ({ matches: false });
  await select(page, 'w1:p3');
  assert.equal(scrolled, 1);
});

test('the viewer survives an inventory render: same box, same text node, new status chip', async (t) => {
  const { c, page } = await open(t);
  await select(page, 'w1:p2');
  const pre = page.find('pre.term'); const node = pre.firstChild;
  assert.equal(page.find('#pane-head .chip').getAttribute('data-s'), 'idle');
  c.herdr.state.panes['w1:p2'].agent_status = 'working';
  page.button('Reconcile now').click(); await page.settle();
  assert.equal(page.find('#pane-head .chip').getAttribute('data-s'), 'working', 'the page did render the change');
  assert.equal(page.find('pre.term'), pre, 'the output box is the same element');
  assert.equal(pre.firstChild, node, 'and holds the same text node');
  await page.tick(5000);
  assert.equal(page.find('pre.term'), pre);
  await select(page, 'w1:p1');
  assert.notEqual(page.find('pre.term'), pre, 'another pane gets its own viewer');
});

test('the screen is polled every 1.5 s with the terminal id, one request at a time', async (t) => {
  const { c, page } = await open(t);
  await select(page, 'w1:p1');
  const base = reads(page, 'visible').length;
  await page.tick(1500);
  await page.tick(1500);
  const polls = reads(page, 'visible').slice(base);
  assert.equal(polls.length, 2);
  assert.ok(polls.every((r) => r.path.includes('expect_terminal_id=term_aa01')));

  c.herdr.state.delayMs['pane.read'] = 700;
  page.advance(1500); // a poll starts and stays in flight
  page.advance(1500); page.advance(1500); page.advance(1500);
  assert.equal(reads(page, 'visible').length - base, 3, 'no second request while one is in flight');
  await page.settle();
});

test('after a failed poll the next one waits 5 s, and a success returns to 1.5 s', async (t) => {
  const { c, page } = await open(t);
  await select(page, 'w1:p1');
  const base = reads(page, 'visible').length;
  c.herdr.state.errorOn['pane.get'] = 'boom';
  await page.tick(1500);
  assert.equal(reads(page, 'visible').length - base, 1);
  assert.match(status(page).textContent, /retrying/);
  assert.ok(status(page).className.includes('error'));
  await page.tick(3000);
  assert.equal(reads(page, 'visible').length - base, 1, 'still waiting');
  delete c.herdr.state.errorOn['pane.get'];
  await page.tick(2000);
  assert.equal(reads(page, 'visible').length - base, 2, 'retried at 5 s');
  assert.ok(!status(page).className.includes('error'));
  await page.tick(1500);
  assert.equal(reads(page, 'visible').length - base, 3, 'back to 1.5 s');
});

test('a hidden tab makes no reads; coming back reads at once', async (t) => {
  const { page } = await open(t);
  await select(page, 'w1:p1');
  page.doc.hidden = true;
  const base = reads(page, 'visible').length;
  await page.tick(9000);
  assert.equal(reads(page, 'visible').length, base);
  page.doc.hidden = false; page.doc.dispatchEvent({ type: 'visibilitychange' }); await page.settle();
  assert.equal(reads(page, 'visible').length, base + 1);
});

test('the view follows new output only when it was at the bottom; otherwise it keeps its place and offers Jump to latest', async (t) => {
  const { c, page } = await open(t);
  await select(page, 'w1:p1');
  const pre = page.find('pre.term'); const jump = page.button('Jump to latest');
  pre.scrollHeight = 1000; pre.clientHeight = 400; pre.scrollTop = 600;
  c.herdr.state.reads['w1:p1'] = { visible: 'newer output' };
  await page.tick(1500);
  assert.equal(pre.textContent, 'newer output');
  assert.equal(pre.scrollTop, 1000, 'it was at the bottom, so it follows');
  assert.equal(jump.hidden, true);

  pre.scrollTop = 100; page.fire(pre, 'scroll');
  assert.equal(jump.hidden, false, 'scrolled up: the button appears');
  c.herdr.state.reads['w1:p1'] = { visible: 'even newer' };
  await page.tick(1500);
  assert.equal(pre.textContent, 'even newer');
  assert.equal(pre.scrollTop, 100, 'the reader keeps their place');
  jump.click();
  assert.equal(pre.scrollTop, 1000);
  assert.equal(jump.hidden, true);
});

test('history controls appear only when health says history is on, and only for panes it covers', async (t) => {
  const off = await open(t);
  await select(off.page, 'w1:p2');
  assert.equal(off.page.button('History').hidden, true);

  const agents = await open(t, { env: { [HISTORY]: 'agents' } });
  await select(agents.page, 'w1:p2');
  assert.equal(agents.page.button('History').hidden, false, 'an agent pane');
  await select(agents.page, 'w1:p1');
  assert.equal(agents.page.button('History').hidden, true, 'a plain pane needs HISTORY=all');

  const all = await open(t, { env: { [HISTORY]: 'all' } });
  await select(all.page, 'w1:p1');
  assert.equal(all.page.button('History').hidden, false);
});

test('History mode reads recent_unwrapped once, stops polling, and Load more doubles the lines while one read is allowed at a time', async (t) => {
  const { c, page } = await open(t, { env: { [HISTORY]: 'all' }, prepare: (x) => { x.herdr.state.scroll['w1:p1'] = metrics(40, 200); x.herdr.state.reads['w1:p1'] = { recent_unwrapped: chat(130), visible: chat(30) }; } });
  await select(page, 'w1:p1');
  page.button('History').click(); await page.settle();
  assert.equal(page.find('pre.term').textContent, chat(130));
  assert.match(status(page).textContent, /^History · 130 lines/);
  const first = reads(page, 'recent_unwrapped');
  assert.equal(first.length, 1);
  assert.match(first[0].path, /lines=500/);
  const visibleBefore = reads(page, 'visible').length;
  await page.tick(6000);
  assert.equal(reads(page, 'visible').length, visibleBefore, 'History does not poll');

  const more = page.button('Load more');
  assert.equal(more.hidden, false);
  c.herdr.state.delayMs['pane.read'] = 600;
  more.click();
  assert.equal(more.disabled, true, 'disabled while the read is in flight');
  await page.settle();
  assert.equal(more.disabled, false);
  assert.match(reads(page, 'recent_unwrapped')[1].path, /lines=1000/);
  more.click(); await page.settle();
  assert.match(reads(page, 'recent_unwrapped')[2].path, /lines=2000/);
  assert.equal(more.disabled, true, 'the cap is 2000');
  page.button('Screen').click(); await page.settle();
  assert.equal(page.find('pre.term').textContent, chat(30), 'back on the live screen');
});

test('a pane with no history beyond its screen shows the neutral line, not an error', async (t) => {
  const { page } = await open(t, { env: { [HISTORY]: 'all' }, prepare: (x) => { x.herdr.state.scroll['w1:p1'] = metrics(40, 0); x.herdr.state.reads['w1:p1'] = { recent_unwrapped: chat(30), visible: chat(30) }; } });
  await select(page, 'w1:p1');
  page.button('History').click(); await page.settle();
  assert.equal(status(page).textContent, 'No history beyond the screen for this pane');
  assert.ok(!status(page).className.includes('error'));
  assert.equal(page.find('pre.term').textContent, chat(30), 'the screen is shown');
});

test('control off: no scroll or click control is shown and no control request is made', async (t) => {
  const { page } = await open(t);
  await select(page, 'w1:p1');
  for (const label of ['Scroll pane up', 'Scroll pane down', 'Pane to bottom', 'Click mode']) assert.equal(page.button(label).hidden, true, label);
  await page.tick(3000);
  assert.equal(page.requests.filter((r) => /pane_scroll|pane_click|pane_get/.test(r.path)).length, 0);
});

test('control on: scroll buttons for plain panes only; Pane to bottom only where Herdr has scrollback', async (t) => {
  const { c, page } = await open(t, { env: { [CONTROL]: '1' } });
  await select(page, 'w1:p1');
  assert.equal(page.button('Scroll pane up').hidden, false);
  assert.equal(page.button('Scroll pane down').hidden, false);
  assert.equal(page.button('Pane to bottom').hidden, true, 'a pane without Herdr scrollback has no bottom to go to');
  await select(page, 'w1:p2');
  for (const label of ['Scroll pane up', 'Scroll pane down', 'Pane to bottom', 'Click mode']) assert.equal(page.button(label).hidden, true, `${label}: not on an agent pane`);

  c.herdr.state.scroll['w1:p1'] = metrics(40, 90);
  await select(page, 'w1:p3'); await select(page, 'w1:p1');
  assert.equal(page.button('Pane to bottom').hidden, false);
});

test('Scroll pane up sends one request, disables the buttons while it runs, and says what happened', async (t) => {
  const { c, page } = await open(t, { env: { [CONTROL]: '1' }, prepare: (x) => { x.herdr.state.scroll['w1:p1'] = metrics(40, 90); } });
  await select(page, 'w1:p1');
  c.herdr.state.delayMs['pane.scroll'] = 500;
  const up = page.button('Scroll pane up');
  up.click();
  assert.equal(up.disabled, true);
  assert.equal(page.button('Pane to bottom').disabled, true);
  await page.settle();
  assert.equal(up.disabled, false);
  const sent = posts(page, 'pane_scroll');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.direction, 'up');
  assert.equal(sent[0].body.expect_terminal_id, 'term_aa01');
  assert.match(status(page).textContent, /Scrolled the pane up \(offset 3 of 90\)/);
  assert.match(status(page).textContent, /stays scrolled for its owner/);
  assert.ok(page.all('#results li').length >= 1, 'the result is in the list');
  page.button('Pane to bottom').click(); await page.settle();
  assert.equal(posts(page, 'pane_scroll')[1].body.direction, 'bottom');
  assert.match(status(page).textContent, /to the bottom \(offset 0 of 90\)/);
});

// ---- click mode ----
const SCREEN = { 3: 'build finished: npm test passed', 5: 'a b c', 7: '[ Allow once ]' };
const screenText = (rows = SCREEN) => Array.from({ length: 47 }, (_, i) => rows[i] || '').join('\n');
const clickReady = async (t, extra = {}) => {
  const o = await open(t, { env: { [CONTROL]: '1', ...extra }, prepare: (x) => { x.herdr.state.scroll['w1:p1'] = metrics(47, 0); x.herdr.state.reads['w1:p1'] = { visible: screenText() }; } });
  await select(o.page, 'w1:p1');
  const pre = o.page.find('pre.term');
  pre.rect = { left: 0, top: 0, width: 600, height: 400 };
  o.page.find('.probe').rect = { left: 0, top: 0, width: 160, height: 16 }; // 20 characters: 8 px each
  o.pre = pre;
  // x = 10 (padding) + column * 8 + 3, y = 10 + row * 16 + 4
  o.tap = (column, row) => o.page.fire(pre, 'click', { clientX: 10 + column * 8 + 3, clientY: 10 + row * 16 + 4 });
  o.go = o.page.button('Click here');
  return o;
};

test('Click mode: a tap highlights the cell, fills in the text run under it and pauses the screen updates', async (t) => {
  const { page, pre, tap, go } = await clickReady(t);
  const node = pre.firstChild;
  assert.equal(page.find('.click-panel').hidden, true);
  page.button('Click mode').click();
  assert.equal(page.find('.click-panel').hidden, false);
  tap(17, 3);
  assert.deepEqual([page.$('click-col').value, page.$('click-row').value, page.$('click-text').value], ['17', '3', 'npm']);
  assert.equal(go.disabled, false);
  assert.equal(page.find('mark.cell').textContent, 'p', 'the tapped cell is marked in the text');
  assert.deepEqual(page.all('.run').map((r) => r.textContent), ['n', 'm'], 'and so is the run that will be sent');
  assert.equal(pre.textContent, screenText(), 'the text itself is unchanged');
  assert.equal(status(page).textContent, 'Screen · updates paused while a click is pending');
  const base = reads(page, 'visible').length;
  await page.tick(4500);
  assert.equal(reads(page, 'visible').length, base, 'the screen does not move under the cell');
  assert.equal(pre.textContent, screenText());
});

test('a run shorter than two characters says "too short to click safely" and cannot be sent', async (t) => {
  const { page, tap, go } = await clickReady(t);
  page.button('Click mode').click();
  tap(0, 5);
  assert.equal(page.$('click-text').value, 'a');
  assert.equal(go.disabled, true);
  assert.equal(page.find('.click-panel .hint').textContent, 'too short to click safely');
  tap(1, 5); // a blank cell
  assert.equal(page.$('click-text').value, '');
  assert.equal(go.disabled, true);
});

test('Click here sends the run under the cell; the answer is shown and updates resume', async (t) => {
  const { page, pre, tap, go } = await clickReady(t);
  page.button('Click mode').click();
  tap(17, 3);
  go.click(); await page.settle();
  const sent = posts(page, 'pane_click');
  assert.equal(sent.length, 1);
  assert.deepEqual({ column: sent[0].body.column, row: sent[0].body.row, button: sent[0].body.button, expect_text: sent[0].body.expect_text, terminal: sent[0].body.expect_terminal_id }, { column: 17, row: 3, button: 'left', expect_text: 'npm', terminal: 'term_aa01' });
  assert.match(status(page).textContent, /^Clicked \(17, 3\) with the left button/);
  assert.equal(page.find('mark.cell'), null);
  assert.equal(pre.childNodes.length, 1, 'the one text node is back');
  assert.equal(page.$('click-text').value, '');
  const base = reads(page, 'visible').length;
  await page.tick(1500);
  assert.ok(reads(page, 'visible').length > base, 'polling is back');
});

test('the keyboard path: column, row and text fields, then the same confirm', async (t) => {
  const { page, go } = await clickReady(t);
  page.button('Click mode').click();
  assert.equal(go.disabled, true);
  for (const [id, v] of [['click-col', '17'], ['click-row', '3'], ['click-text', 'npm test']]) { page.$(id).value = v; page.fire(page.$(id), 'input'); }
  assert.equal(go.disabled, false);
  go.click(); await page.settle();
  const sent = posts(page, 'pane_click');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.expect_text, 'npm test');
});

test('a refusal is shown with its reason, the row is returned for a screen change, and nothing is sent again', async (t) => {
  const { c, page, tap, go } = await clickReady(t);
  page.button('Click mode').click();
  tap(17, 3);
  c.herdr.state.reads['w1:p1'] = { visible: screenText({ ...SCREEN, 3: 'build finished: yarn test passed' }) };
  go.click(); await page.settle();
  assert.match(status(page).textContent, /^Not sent: screen_changed: /);
  assert.match(status(page).textContent, /The row now reads: build finished: yarn test passed/);
  assert.ok(status(page).className.includes('error'));
  await page.tick(4000);
  assert.equal(posts(page, 'pane_click').length, 1, 'no automatic retry');
  assert.ok(page.all('#results li').some((li) => li.textContent.includes('pane_click')));

  c.herdr.state.reads['w1:p1'] = { visible: screenText() };
  tap(5, 7); // "Allow"
  assert.equal(page.$('click-text').value, 'Allow');
  go.click(); await page.settle();
  assert.match(status(page).textContent, /^Not sent: escalate_to_owner: /);
  assert.equal(posts(page, 'pane_click').length, 2);
});

test('a row the server cannot map to a cell is refused with its reason and nothing is retried', async (t) => {
  const { c, page, tap, go } = await clickReady(t, {});
  c.herdr.state.reads['w1:p1'] = { visible: screenText({ ...SCREEN, 9: '中文 Save here' }) };
  await page.tick(1500);
  page.button('Click mode').click();
  tap(4, 9);
  assert.equal(page.$('click-text').value, 'Save');
  go.click(); await page.settle();
  assert.match(status(page).textContent, /^Not sent: row_not_cell_mappable: /);
  assert.ok(status(page).className.includes('error'));
  await page.tick(4000);
  assert.equal(posts(page, 'pane_click').length, 1, 'no automatic retry');
});

test('the first screen read says it is reading, then the live status takes over', async (t) => {
  const c = await setup(t);
  const page = loadPage({ port: c.port });
  page.$('token').value = TOKEN;
  page.fire(page.$('login-form'), 'submit');
  await page.settle();
  treeButton(page, 'w1:p1').click();
  assert.match(status(page).textContent, /^Screen · reading…/);
  await page.settle();
  assert.match(status(page).textContent, /^Screen · live/);
});

test('click mode is offered on agent panes only when the owner enabled agent clicks, and not while the agent works or is blocked', async (t) => {
  const off = await open(t, { env: { [CONTROL]: '1' } });
  await select(off.page, 'w1:p2');
  assert.equal(off.page.button('Click mode').hidden, true);
  const on = await open(t, { env: { [CONTROL]: '1', [AGENT_CLICK]: '1' } });
  await select(on.page, 'w1:p2');
  assert.equal(on.page.button('Click mode').hidden, false);
  assert.equal(on.page.button('Scroll pane up').hidden, true, 'agent panes are never scrolled');
  await select(on.page, 'w1:p3');
  assert.equal(on.page.find('#pane-head .chip').getAttribute('data-s'), 'blocked');
  assert.equal(on.page.button('Click mode').hidden, true, 'the server refuses a click on a blocked agent, so the page does not offer one');
});

test('the pane view and its output box use no inline styles in the markup', async (t) => {
  const { page } = await open(t);
  await select(page, 'w1:p1');
  assert.equal(page.all('[style]').length, 0);
});

test('signing out removes the viewer and stops its polling', async (t) => {
  const { page } = await open(t);
  await select(page, 'w1:p1');
  page.$('logout').click();
  assert.equal(page.$('viewer').children.length, 0);
  const n = page.requests.length;
  await page.tick(6000);
  assert.equal(page.requests.length, n, 'no request after sign-out');
});
