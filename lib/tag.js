'use strict';
// A display-only label Herdr can show beside an agent in its sidebar: what the portal last did to that pane, and when.
// It holds a verb, an outcome and a time, never input text, and it is best effort: a Herdr that refuses or ignores it changes nothing.
const herdr = require('./herdr');

const SOURCE = 'custom:herdr-tunnel';
const TOKEN = 'tunnel_last';
const TTL_MS = 15 * 60 * 1000;
const TAG_MAX = 80; // what Herdr keeps of a token value
const OUTCOME = { input_sent: 'sent', input_sent_queued: 'queued', needs_review: 'needs review' };

const verb = (action) => String(action).replace(/^herdr\./, '').replace(/^(agent|pane)_/, '').replace(/_/g, ' ');

// null for a result that is not activity on the pane (a refusal, a failure, an agent start).
function tagText(action, status, at = new Date()) {
  const outcome = OUTCOME[status];
  if (!outcome) return null;
  const hhmm = [at.getHours(), at.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${verb(action)} ${outcome} ${hhmm}`.slice(0, TAG_MAX);
}

function tagPane(sock, paneId, action, status) {
  const text = tagText(action, status);
  if (!text) return;
  herdr.call(sock, 'pane.report_metadata', { pane_id: paneId, source: SOURCE, tokens: { [TOKEN]: text }, ttl_ms: TTL_MS, seq: Date.now() }, { timeoutMs: 2000 }).catch(() => {});
}

module.exports = { SOURCE, TOKEN, TTL_MS, tagText, tagPane };
