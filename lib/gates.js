'use strict';
// Owner opt-ins. Each capability is off until its variable says otherwise; dispatch() and /api/health read the same values here.
const HISTORY = 'HERDR_PORTAL_ENABLE_HISTORY';
const CONTROL = 'HERDR_PORTAL_ENABLE_CONTROL';
const AGENT_CLICK = 'HERDR_PORTAL_ENABLE_AGENT_CLICK';
const TAG_PANES = 'HERDR_PORTAL_TAG_PANES';

const isOne = (env, name) => env[name] === '1';

// 'agents' reads recognized-agent panes only, 'all' adds plain panes (their scrollback can hold keys and tokens). A value
// that is none of these turns history off and reads 'invalid' in health, so a typo is never mistaken for a choice.
function history(env) {
  const v = env[HISTORY];
  if (v === undefined || v === '' || v === '0') return false;
  if (v === '1' || v === 'agents') return 'agents';
  if (v === 'all') return 'all';
  return 'invalid';
}

// Like history, a value that is not 1, 0 or empty reads 'invalid': the feature stays off and health says why.
const flag = (env, name) => (isOne(env, name) ? true : env[name] === undefined || env[name] === '' || env[name] === '0' ? false : 'invalid');

function capabilities(env = process.env) {
  const control = flag(env, CONTROL);
  const click = flag(env, AGENT_CLICK);
  return { history: history(env), control, agent_click: click === 'invalid' ? 'invalid' : control === true && click, tag_panes: flag(env, TAG_PANES) };
}

const gateOpen = (name, env = process.env) => isOne(env, name);

module.exports = { HISTORY, CONTROL, AGENT_CLICK, TAG_PANES, capabilities, gateOpen };
