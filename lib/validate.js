'use strict';
// Strict input schemas: unknown keys are rejected, every field is typed and bounded.
class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}

const RE = {
  session: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
  pane: /^w[0-9A-Za-z]{1,16}:p[0-9A-Za-z]{1,16}$/,
  workspace: /^w[0-9A-Za-z]{1,16}$/,
  tab: /^w[0-9A-Za-z]{1,16}:t[0-9A-Za-z]{1,16}$/,
  terminal: /^term_[0-9a-f]{4,40}$/,
  requestId: /^[A-Za-z0-9._-]{8,128}$/,
  idemKey: /^[A-Za-z0-9._-]{16,128}$/,
  agentName: /^[a-z][a-z0-9_-]{0,31}$/,
};

// Documented in CLI ref > Panes > Send input.
const NAMED_KEYS = new Set(['enter', 'tab', 'esc', 'escape', 'backspace', 'left', 'right', 'up', 'down', 'minus', 'plus', 'backtick']);
const MODS = new Set(['ctrl', 'control', 'alt', 'shift']);
function validKey(k) {
  if (typeof k !== 'string' || k.length === 0 || k.length > 24) return false;
  if (/^C-[a-z]$/i.test(k)) return true; // documented legacy alias for ctrl+<letter>
  const parts = k.toLowerCase().split('+');
  if (k === '+') return false;
  const base = parts.pop();
  if (!base) return false;
  if (!parts.every((p) => MODS.has(p)) || new Set(parts).size !== parts.length) return false;
  if (NAMED_KEYS.has(base)) return true;
  if (/^f([1-9]|1[0-2])$/.test(base)) return true;
  return /^[\x21-\x7e]$/.test(base); // plain printable key; '+' itself must be spelled `plus`
}

// Keys allowed toward an agent UI. Anything that can CONFIRM a dialog (enter, y/n, digits, letters) is excluded:
// an approval dialog can appear between the status check and delivery, and answering it is the owner's decision, made in Herdr.
const AGENT_KEYS = new Set(['esc', 'escape', 'ctrl+c', 'up', 'down', 'left', 'right', 'tab', 'shift+tab', 'backspace']);
const validAgentKey = (k) => typeof k === 'string' && AGENT_KEYS.has(k.toLowerCase());

const hasBadControl = (s, allowNewline) => (allowNewline ? /[\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(s);

const T = {
  any: ({ optional = false } = {}) => ({ optional, check: () => true }), // the action checks the value itself and answers with a specific code
  str: (re, { optional = false } = {}) => ({ optional, check: (v) => typeof v === 'string' && re.test(v) }),
  int: (min, max, { optional = false } = {}) => ({ optional, check: (v) => Number.isInteger(v) && v >= min && v <= max }),
  enum: (vals, { optional = false } = {}) => ({ optional, check: (v) => vals.includes(v) }),
  text: (maxLen, { newline = false, optional = false, noLeadingDash = false } = {}) => ({
    optional,
    check: (v) => typeof v === 'string' && v.length > 0 && v.length <= maxLen && !hasBadControl(v, newline) && !(noLeadingDash && v.trimStart().startsWith('-')),
  }),
  agentKeys: (maxCount) => ({ optional: false, check: (v) => Array.isArray(v) && v.length > 0 && v.length <= maxCount && v.every(validAgentKey) }),
  // A prompt gets Enter appended by Herdr, so a bare "y", "1", whitespace or "\n" would answer a dialog that appeared late.
  prompt: (maxLen) => ({
    optional: false,
    check: (v) => typeof v === 'string' && v.length <= maxLen && /\S/.test(v) && !hasBadControl(v, true) && !/^\s*(y|n|yes|no|ok|enter|\d{1,3})\s*$/i.test(v),
  }),
  keys: (maxCount) => ({ optional: false, check: (v) => Array.isArray(v) && v.length > 0 && v.length <= maxCount && v.every(validKey) }),
  enumList: (vals, maxCount, { optional = false } = {}) => ({
    optional,
    check: (v) => Array.isArray(v) && v.length > 0 && v.length <= maxCount && v.every((x) => vals.includes(x)),
  }),
};

function validate(spec, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'bad_params', 'params must be an object');
  for (const k of Object.keys(input)) if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new ApiError(400, 'unknown_param', `unknown parameter: ${k.slice(0, 40)}`);
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = input[k];
    if (v === undefined || v === null) {
      if (s.optional) continue;
      throw new ApiError(400, 'missing_param', `missing parameter: ${k}`);
    }
    if (!s.check(v)) throw new ApiError(400, 'invalid_param', `invalid parameter: ${k}`);
    out[k] = v;
  }
  return out;
}

module.exports = { ApiError, RE, T, validate, validKey, validAgentKey, AGENT_KEYS };
