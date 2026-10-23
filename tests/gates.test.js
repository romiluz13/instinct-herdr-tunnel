'use strict';
// Owner opt-ins: how the gate variables are read, how an action behind a gate is refused, and what health reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const { capabilities } = require('../lib/gates');
const { ACTIONS, dispatch } = require('../lib/actions');
const { ApiError, T } = require('../lib/validate');
const { req, setup } = require('./fixtures/harness');

const H = 'HERDR_PORTAL_ENABLE_HISTORY';
const C = 'HERDR_PORTAL_ENABLE_CONTROL';
const A = 'HERDR_PORTAL_ENABLE_AGENT_CLICK';

test('history gate: unset, 0, 1, agents and all are understood (case-sensitive); anything else is off and reported invalid', () => {
  const history = (v) => capabilities(v === undefined ? {} : { [H]: v }).history;
  for (const [value, want] of [[undefined, false], ['', false], ['0', false], ['1', 'agents'], ['agents', 'agents'], ['all', 'all'],
    ['ALL', 'invalid'], ['All', 'invalid'], ['true', 'invalid'], ['yes', 'invalid'], ['agent', 'invalid'], [' all', 'invalid'], ['2', 'invalid']]) {
    assert.equal(history(value), want, JSON.stringify(value));
  }
});

test('control gate accepts only 1; agent click needs control as well', () => {
  const caps = (env) => capabilities(env);
  assert.deepEqual(caps({}), { history: false, control: false, agent_click: false, tag_panes: false });
  for (const v of ['0', '']) assert.equal(caps({ [C]: v }).control, false, JSON.stringify(v));
  for (const v of ['true', 'yes', 'on', '2']) assert.equal(caps({ [C]: v }).control, 'invalid', JSON.stringify(v));
  assert.equal(caps({ [C]: '1' }).control, true);
  assert.deepEqual(caps({ [A]: '1' }), { history: false, control: false, agent_click: false, tag_panes: false }, 'agent click alone is not on');
  assert.equal(caps({ [C]: '1', [A]: '1' }).agent_click, true);
  assert.equal(caps({ [C]: '1', [A]: 'true' }).agent_click, 'invalid');
  assert.equal(caps({ [C]: '1', [A]: '0' }).agent_click, false);
  assert.equal(caps({ [C]: '0', [A]: '1' }).agent_click, false);
});

test('dispatch: an action with a gate is 404 action_disabled until its variable is 1, and the gate is checked before validation', async () => {
  const name = 'herdr.test_gated';
  ACTIONS[name] = { summary: 'test only', params: { n: T.int(1, 5) }, gate: C, proof: { portal: true, uses: [], docs: [] }, async run(_ctx, p) { return { ok: true, n: p.n }; } };
  const saved = process.env[C];
  try {
    delete process.env[C];
    await assert.rejects(dispatch({}, name, 'GET', {}), (e) => e instanceof ApiError && e.status === 404 && e.code === 'action_disabled', 'off: refused even though the parameters are invalid');
    process.env[C] = 'true';
    await assert.rejects(dispatch({}, name, 'GET', { n: 2 }), (e) => e.code === 'action_disabled', 'only 1 opens the gate');
    process.env[C] = '1';
    await assert.rejects(dispatch({}, name, 'GET', {}), (e) => e.code === 'missing_param', 'on: validation runs');
    assert.deepEqual(await dispatch({}, name, 'GET', { n: 2 }), { ok: true, n: 2 });
  } finally {
    delete ACTIONS[name];
    if (saved === undefined) delete process.env[C]; else process.env[C] = saved;
  }
});

test('health reports the effective capabilities; a mistyped value is off, flagged invalid and logged at startup', async (t) => {
  const off = await setup(t);
  assert.deepEqual((await req(off.port, 'GET', '/api/health')).json.capabilities, { history: false, control: false, agent_click: false, tag_panes: false });
  const on = await setup(t, { env: { [H]: 'ALL', [C]: '1', [A]: '1' } });
  assert.deepEqual((await req(on.port, 'GET', '/api/health')).json.capabilities, { history: 'invalid', control: true, agent_click: true, tag_panes: false });
  assert.match(on.proc.out(), /"event":"gate_invalid"[^\n]*HERDR_PORTAL_ENABLE_HISTORY/);
  const typo = await setup(t, { env: { [C]: 'true', [A]: 'yes' } });
  assert.deepEqual((await req(typo.port, 'GET', '/api/health')).json.capabilities, { history: false, control: 'invalid', agent_click: 'invalid', tag_panes: false });
  assert.match(typo.proc.out(), /"event":"gate_invalid"[^\n]*HERDR_PORTAL_ENABLE_CONTROL/);
  assert.match(typo.proc.out(), /"event":"gate_invalid"[^\n]*HERDR_PORTAL_ENABLE_AGENT_CLICK/);
  const agents = await setup(t, { env: { [H]: '1', [A]: '1' } });
  assert.deepEqual((await req(agents.port, 'GET', '/api/health')).json.capabilities, { history: 'agents', control: false, agent_click: false, tag_panes: false });
});

test('the pane-tag gate accepts only 1 and stands alone: it needs neither control nor history', () => {
  const T = 'HERDR_PORTAL_TAG_PANES';
  assert.equal(capabilities({ [T]: '1' }).tag_panes, true);
  for (const v of ['0', '']) assert.equal(capabilities({ [T]: v }).tag_panes, false, JSON.stringify(v));
  for (const v of ['true', 'yes', '2']) assert.equal(capabilities({ [T]: v }).tag_panes, 'invalid', JSON.stringify(v));
  assert.deepEqual(capabilities({ [T]: '1' }), { history: false, control: false, agent_click: false, tag_panes: true });
});
