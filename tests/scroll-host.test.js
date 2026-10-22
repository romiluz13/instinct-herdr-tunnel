'use strict';
// pane_scroll on a pane with Herdr scrollback: the socket's pane.scroll with an absolute offset, no controller.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { req, setup } = require('./fixtures/harness');

const body = (extra = {}) => ({ session: 'default', pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
const scrollPost = (c, extra) => req(c.port, 'POST', '/api/herdr/pane_scroll', { body: body(extra) });
const on = { env: { HERDR_PORTAL_ENABLE_CONTROL: '1' } };
const hostPane = (c, { offset = 0, max = 90, rows = 40 } = {}) => { c.herdr.state.scroll['w1:p1'] = { offset_from_bottom: offset, max_offset_from_bottom: max, viewport_rows: rows }; };
const jsonl = (c, f) => { try { return fs.readFileSync(path.join(c.dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const scrollCalls = (c) => c.herdr.calls.filter((x) => x.method === 'pane.scroll').map((x) => x.params);

test('up moves the real offset by 3 lines per step, with the positions before and after and no controller', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  const r = await scrollPost(c, { direction: 'up', steps: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'input_sent');
  assert.equal(r.json.detail.delivered_as, 'host_scrollback');
  assert.deepEqual(r.json.detail.scroll_before, { offset_from_bottom: 0, max_offset_from_bottom: 90 });
  assert.deepEqual(r.json.detail.scroll_after, { offset_from_bottom: 6, max_offset_from_bottom: 90 });
  assert.deepEqual(scrollCalls(c), [{ pane_id: 'w1:p1', offset_from_bottom: 6 }]);
  assert.equal(jsonl(c, 'control-calls.jsonl').length, 0, 'no controller was started');
  assert.equal(jsonl(c, 'tool-calls.jsonl').length, 0, 'the tty size check is not run on this path');
});

test('the response says the offset stays for the owner until it is reset', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  const r = await scrollPost(c, { direction: 'up' });
  assert.match(r.json.detail.note, /stays scrolled/);
  assert.match(r.json.detail.note, /pane to bottom/i);
});

test('the offset is clamped to the scrollback on both ends', async (t) => {
  const c = await setup(t, on);
  hostPane(c, { offset: 80, max: 90 });
  const top = await scrollPost(c, { direction: 'up', steps: 50 });
  assert.equal(top.json.detail.scroll_after.offset_from_bottom, 90);
  hostPane(c, { offset: 2, max: 90 });
  const bottom = await scrollPost(c, { direction: 'down', steps: 5 });
  assert.equal(bottom.json.detail.scroll_after.offset_from_bottom, 0);
  assert.deepEqual(scrollCalls(c).map((x) => x.offset_from_bottom), [90, 0], 'the portal sends the clamped value');
});

test('down moves toward the bottom from where the pane is now', async (t) => {
  const c = await setup(t, on);
  hostPane(c, { offset: 10 });
  const r = await scrollPost(c, { direction: 'down' });
  assert.equal(r.json.detail.scroll_before.offset_from_bottom, 10);
  assert.equal(r.json.detail.scroll_after.offset_from_bottom, 7);
});

test('bottom is offset 0 whatever steps says, and it works from the top and from the bottom', async (t) => {
  const c = await setup(t, on);
  hostPane(c, { offset: 60 });
  const r = await scrollPost(c, { direction: 'bottom', steps: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.detail.delivered_as, 'host_scrollback');
  assert.equal(r.json.detail.scroll_after.offset_from_bottom, 0);
  hostPane(c, { offset: 0 });
  assert.equal((await scrollPost(c, { direction: 'bottom' })).status, 200);
  assert.deepEqual(scrollCalls(c).map((x) => x.offset_from_bottom), [0, 0]);
  assert.equal(jsonl(c, 'control-calls.jsonl').length, 0);
});

test('a Herdr whose schema lacks pane.scroll is refused up front with 503 contract_mismatch, and no wheel fallback runs', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  fs.writeFileSync(path.join(c.dir, 'schema-patch.json'), JSON.stringify({ drop: ['pane.scroll'] }));
  await c.restart();
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'contract_mismatch');
  assert.match(r.json.error.message, /pane\.scroll is not in this Herdr's schema/);
  assert.equal(scrollCalls(c).length, 0);
  assert.equal(jsonl(c, 'control-calls.jsonl').length, 0, 'no controller as a fallback');
});

test('a Herdr that lists pane.scroll but reports the method unknown gives 422 scroll_unsupported and does not fall back to wheel events', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  c.herdr.state.noScrollMethod = true;
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 422);
  assert.equal(r.json.status, 'failed');
  assert.equal(r.json.detail.error, 'scroll_unsupported');
  assert.equal(jsonl(c, 'control-calls.jsonl').length, 0, 'no controller as a fallback');
});

test('a scroll whose answer never arrives is needs_review, never a quiet success', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  c.herdr.state.hangOn = 'pane.scroll';
  const r = await scrollPost(c, { direction: 'up' });
  assert.equal(r.status, 502);
  assert.equal(r.json.status, 'needs_review');
});

test('the audit line carries the direction, the steps and the path, not any pane text', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  await scrollPost(c, { direction: 'up', steps: 4 });
  const line = jsonl({ dir: path.join(c.dir, 'logs') }, 'audit.jsonl').find((l) => l.action === 'herdr.pane_scroll');
  assert.deepEqual(line.scroll, { direction: 'up', steps: 4, delivered_as: 'host_scrollback' });
});

test('the same idempotency key replays the stored answer and scrolls once', async (t) => {
  const c = await setup(t, on);
  hostPane(c);
  const b = body({ direction: 'up' });
  const a = await req(c.port, 'POST', '/api/herdr/pane_scroll', { body: b });
  const again = await req(c.port, 'POST', '/api/herdr/pane_scroll', { body: b });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.detail.scroll_after, a.json.detail.scroll_after);
  assert.equal(scrollCalls(c).length, 1);
});

test('a recognized agent is still refused here: scrolling would stop Herdr from reading its history', async (t) => {
  const c = await setup(t, on);
  c.herdr.state.scroll['w1:p2'] = { offset_from_bottom: 0, max_offset_from_bottom: 90, viewport_rows: 40 };
  const r = await scrollPost(c, { pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', direction: 'up' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'use_history_read');
  assert.equal(scrollCalls(c).length, 0);
});
