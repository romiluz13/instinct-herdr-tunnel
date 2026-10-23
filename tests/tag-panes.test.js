'use strict';
// The display-only tag the portal puts on a pane after it sends input there (HERDR_PORTAL_TAG_PANES=1), shown by Herdr in its Agents sidebar.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { req, setup } = require('./fixtures/harness');
const { tagText } = require('../lib/tag');

const ON = { env: { HERDR_PORTAL_TAG_PANES: '1' } };
const wb = (extra = {}) => ({ session: 'default', pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
const post = (c, action, body) => req(c.port, 'POST', `/api/herdr/${action}`, { body });
const tags = (c) => c.herdr.calls.filter((x) => x.method === 'pane.report_metadata');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(25); } }

test('off unless the owner turns it on: a prompt is sent and nothing is tagged', async (t) => {
  const c = await setup(t);
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  const r = await post(c, 'agent_prompt', wb({ text: 'run the tests please' }));
  assert.equal(r.json.status, 'input_sent');
  await sleep(300);
  assert.equal(tags(c).length, 0);
  assert.equal((await req(c.port, 'GET', '/api/health')).json.capabilities.tag_panes, false);
});

test('on: a prompt that was sent tags that pane with what was done and when, and nothing else about it', async (t) => {
  const c = await setup(t, ON);
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  const text = 'secret-looking prompt text that must never reach a sidebar';
  const r = await post(c, 'agent_prompt', wb({ text }));
  assert.equal(r.status, 200); assert.equal(r.json.status, 'input_sent');
  assert.ok(await until(() => tags(c).length === 1), 'the tag arrived');
  const p = tags(c)[0].params;
  assert.deepEqual(Object.keys(p).sort(), ['pane_id', 'seq', 'source', 'tokens', 'ttl_ms']);
  assert.equal(p.pane_id, 'w1:p2'); assert.equal(p.source, 'custom:herdr-tunnel'); assert.equal(p.ttl_ms, 900000);
  assert.ok(Number.isInteger(p.seq) && p.seq > 0, 'a sequence number, so a late report cannot overwrite a newer one');
  assert.deepEqual(Object.keys(p.tokens), ['tunnel_last']);
  assert.match(p.tokens.tunnel_last, /^prompt sent \d\d:\d\d$/);
  assert.ok(!JSON.stringify(c.herdr.calls).includes('secret-looking') || c.herdr.calls.filter((x) => JSON.stringify(x).includes('secret-looking')).every((x) => x.method === 'agent.prompt'), 'the text goes to the agent only');
  assert.equal((await req(c.port, 'GET', '/api/health')).json.capabilities.tag_panes, true);
});

test('a prompt queued to a working agent and a command run in a pane are tagged as such', async (t) => {
  const c = await setup(t, ON);
  c.herdr.state.panes['w1:p2'].agent_status = 'working';
  assert.equal((await post(c, 'agent_prompt', wb({ text: 'also update the docs' }))).json.status, 'input_sent_queued');
  assert.ok(await until(() => tags(c).length === 1));
  assert.match(tags(c)[0].params.tokens.tunnel_last, /^prompt queued \d\d:\d\d$/);
  const run = await post(c, 'pane_run', wb({ pane_id: 'w1:p1', expect_terminal_id: 'term_aa01', text: 'ls' }));
  assert.equal(run.status, 200, run.text);
  assert.ok(await until(() => tags(c).length === 2));
  assert.equal(tags(c)[1].params.pane_id, 'w1:p1');
  assert.match(tags(c)[1].params.tokens.tunnel_last, /^run sent \d\d:\d\d$/);
});

test('a write whose outcome is uncertain is tagged "needs review", not "sent"', async (t) => {
  const c = await setup(t, ON);
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  c.herdr.state.errorOn['agent.prompt'] = 'timeout';
  const r = await post(c, 'agent_prompt', wb({ text: 'a prompt whose delivery is unknown', wait_timeout_ms: 1000 }));
  assert.equal(r.json.status, 'needs_review', r.text);
  assert.ok(await until(() => tags(c).length === 1));
  assert.match(tags(c)[0].params.tokens.tunnel_last, /^prompt needs review \d\d:\d\d$/);
});

test('nothing is tagged when nothing was sent: a refused prompt, a bad request, a replay', async (t) => {
  const c = await setup(t, ON);
  const blocked = await post(c, 'agent_prompt', wb({ pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', text: 'yes please continue' }));
  assert.equal(blocked.status, 409);
  const bad = await post(c, 'agent_prompt', wb({ text: '' }));
  assert.equal(bad.status, 400);
  const unknownPane = await post(c, 'agent_prompt', wb({ pane_id: 'w9:p9', text: 'hello there friend' }));
  assert.ok(unknownPane.status >= 400);
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  const body = wb({ text: 'one real prompt' });
  assert.equal((await post(c, 'agent_prompt', body)).json.status, 'input_sent');
  assert.ok(await until(() => tags(c).length === 1));
  assert.equal((await post(c, 'agent_prompt', body)).json.replayed, true);
  await sleep(300);
  assert.equal(tags(c).length, 1, 'the replay sent nothing and tagged nothing');
});

test('a tag Herdr refuses, or never answers, does not change the write or hold up its answer', async (t) => {
  const c = await setup(t, ON);
  c.herdr.state.panes['w1:p2'].agent_status = 'idle';
  c.herdr.state.errorOn['pane.report_metadata'] = 'unknown_method';
  const failed = await post(c, 'agent_prompt', wb({ text: 'first prompt text' }));
  assert.equal(failed.status, 200); assert.equal(failed.json.status, 'input_sent');
  await sleep(500);
  assert.equal(c.proc.child.exitCode, null, 'the portal is still running after Herdr refused the tag');
  assert.equal((await req(c.port, 'GET', '/api/health')).status, 200);
  c.herdr.state.errorOn = {};
  c.herdr.state.delayMs['pane.report_metadata'] = 4000;
  const t0 = Date.now();
  const slow = await post(c, 'agent_prompt', wb({ text: 'second prompt text' }));
  assert.equal(slow.status, 200); assert.equal(slow.json.status, 'input_sent');
  assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms, not after the tag`);
  const tail = (await req(c.port, 'GET', '/api/herdr/audit_tail?n=5')).json.entries;
  assert.deepEqual(tail.slice(0, 2).map((e) => e.result), ['input_sent', 'input_sent']);
});

test('tagText names the verb and the outcome, in the 80 characters Herdr keeps', () => {
  const at = new Date(2026, 9, 23, 14, 7, 30);
  assert.equal(tagText('herdr.agent_prompt', 'input_sent', at), 'prompt sent 14:07');
  assert.equal(tagText('herdr.agent_prompt', 'input_sent_queued', at), 'prompt queued 14:07');
  assert.equal(tagText('herdr.pane_run', 'input_sent', at), 'run sent 14:07');
  assert.equal(tagText('herdr.agent_send_keys', 'input_sent', at), 'send keys sent 14:07');
  assert.equal(tagText('herdr.pane_click', 'input_sent', at), 'click sent 14:07');
  assert.equal(tagText('herdr.agent_prompt', 'needs_review', at), 'prompt needs review 14:07');
  assert.equal(tagText('herdr.agent_start', 'agent_started', at), null, 'starting an agent is not activity on an existing pane');
  assert.equal(tagText('herdr.agent_prompt', 'failed', at), null, 'a refusal is not shown as activity');
  assert.ok(tagText('herdr.' + 'x'.repeat(200), 'input_sent', at).length <= 80);
});
