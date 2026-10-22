'use strict';
// agent_prompt to a working agent: submitted and reported as input_sent_queued. A blocked agent still gets nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { req, setup } = require('./fixtures/harness');

const wb = (extra = {}) => ({ session: 'default', pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), ...extra });
const prompt = (c, body) => req(c.port, 'POST', '/api/herdr/agent_prompt', { body });
const status = (c, s, pane = 'w1:p2') => { c.herdr.state.panes[pane].agent_status = s; };
const called = (c, method) => c.herdr.calls.filter((x) => x.method === method);
const DIALOG = { header: ['Do you want to proceed?'], options: ['Yes', 'No'], cursor: 0, numbered: true };

test('a prompt to a working agent is submitted once and reported as input_sent_queued', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  const body = wb({ text: 'when you are done, also update the README' });
  const r = await prompt(c, body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 'input_sent_queued');
  assert.equal(r.json.target.agent_status_at_preflight, 'working');
  assert.equal(r.json.detail.task_completed, null);
  assert.match(r.json.detail.note, /queue/i);
  assert.equal(called(c, 'agent.prompt').length, 1);
  assert.deepEqual(called(c, 'agent.prompt')[0].params, { target: 'w1:p2', text: body.text });
  assert.equal(called(c, 'agent.send_keys').length, 0, 'no key was sent');
  const again = await prompt(c, body);
  assert.equal(again.json.replayed, true); assert.equal(again.json.status, 'input_sent_queued');
  assert.equal(called(c, 'agent.prompt').length, 1, 'the replay sent nothing');
  const tail = (await req(c.port, 'GET', '/api/herdr/audit_tail?n=5')).json.entries;
  assert.deepEqual([tail[0].action, tail[0].result, tail[0].http_status], ['herdr.agent_prompt', 'input_sent_queued', 200]);
  assert.ok(!JSON.stringify(tail).includes(body.text), 'no prompt text in the audit log');
});

test('idle and done agents keep the plain input_sent', async (t) => {
  const c = await setup(t);
  for (const s of ['idle', 'done']) {
    status(c, s);
    const r = await prompt(c, wb({ text: 'next step please' }));
    assert.equal(r.json.status, 'input_sent', s);
    assert.equal(r.json.detail.note, undefined, s);
  }
});

test('a wait on a working agent is sent and the result says the wait follows the running turn', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  const r = await prompt(c, wb({ text: 'one more thing', wait_timeout_ms: 1000 }));
  assert.equal(r.json.status, 'input_sent_queued', r.text);
  assert.equal(r.json.detail.waited, true);
  assert.match(r.json.detail.note, /turn/);
});

test('a blocked or unclassified agent still receives nothing, and no approve or deny route exists', async (t) => {
  const c = await setup(t);
  const blocked = await prompt(c, wb({ pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', text: 'yes please continue' }));
  assert.equal(blocked.status, 409); assert.equal(blocked.json.error.code, 'blocked_requires_decision');
  status(c, 'unknown');
  const unknown = await prompt(c, wb({ text: 'hello again' }));
  assert.equal(unknown.status, 409); assert.equal(unknown.json.error.code, 'agent_state_not_writable');
  assert.equal(c.herdr.writes().length, 0, 'nothing was sent to either pane');
  for (const a of ['approve', 'deny', 'agent_approve', 'agent_deny']) assert.equal((await req(c.port, 'POST', '/api/herdr/' + a, { body: wb() })).status, 404, a);
  const listed = (await req(c.port, 'GET', '/api/herdr')).json.actions.map((a) => a.action);
  assert.ok(listed.includes('herdr.agent_prompt'));
  assert.deepEqual(listed.filter((n) => /approve|deny/.test(n)), []);
  const decision = await req(c.port, 'POST', '/api/herdr/agent_decision', { body: wb({ pane_id: 'w1:p3', expect_terminal_id: 'term_aa03', option: 'Yes' }) });
  assert.equal(decision.status, 404); assert.equal(decision.json.error.code, 'action_disabled');
  assert.equal(c.herdr.writes().length, 0);
});

test('a working agent that shows a dialog is refused before anything is sent, and the key stays usable', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  c.herdr.state.dialogs['w1:p2'] = DIALOG;
  const body = wb({ text: 'carry on with the refactor' });
  const r = await prompt(c, body);
  assert.equal(r.status, 409, r.text); assert.equal(r.json.error.code, 'dialog_on_screen');
  assert.equal(c.herdr.writes().length, 0);
  delete c.herdr.state.dialogs['w1:p2'];
  const ok = await prompt(c, body);
  assert.equal(ok.json.status, 'input_sent_queued', ok.text);
  assert.equal(ok.json.replayed, false);
  assert.equal(called(c, 'agent.prompt').length, 1);
});

test('a working agent whose screen cannot be read is refused', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  c.herdr.state.errorOn['pane.read'] = 'read_failed';
  const r = await prompt(c, wb({ text: 'anything at all' }));
  assert.equal(r.status, 502, r.text); assert.equal(r.json.error.code, 'screen_unreadable');
  assert.equal(c.herdr.writes().length, 0);
});

test('Herdr rejecting the prompt because the agent became blocked is failed, never queued', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  c.herdr.state.errorOn['agent.prompt'] = 'agent_blocked';
  const r = await prompt(c, wb({ text: 'one last request' }));
  assert.equal(r.json.status, 'failed', r.text); assert.equal(r.json.ok, false);
  assert.equal(r.json.detail.error, 'agent_blocked');
});

test('with a wait, Herdr refusing a blocked agent is still failed: it sent nothing, so delivery is not likely', async (t) => {
  const c = await setup(t);
  status(c, 'working');
  c.herdr.state.errorOn['agent.prompt'] = 'agent_blocked';
  const r = await prompt(c, wb({ text: 'one last request', wait_timeout_ms: 1000 }));
  assert.equal(r.json.status, 'failed', r.text); assert.equal(r.json.detail.error, 'agent_blocked');
  c.herdr.state.errorOn['agent.prompt'] = 'agent_not_running';
  const other = await prompt(c, wb({ text: 'and another one', wait_timeout_ms: 1000 }));
  assert.equal(other.json.status, 'needs_review', 'any other error after a wait stays uncertain');
});
