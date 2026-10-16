#!/usr/bin/env node
'use strict';
// Live proof that agent_decision REFUSES what it must refuse, against the REAL Herdr, through any base URL.
// It never answers a trust, permission or auto-mode dialog: the scenario that used to grant a folder-trust dialog
// was removed because that decision belongs to the owner (see docs/agent-decision.md). Every request here is
// expected to be refused with nothing sent. The portal under test must have agent_decision switched on
// (HERDR_PORTAL_ENABLE_AGENT_DECISION=1 in ITS environment); without that it answers 404 action_disabled.
// Panes are staged beforehand in a test workspace:
//   --refuse-pane/--refuse-term   a real Bash permission dialog for `rm -f <file>` (claude --permission-mode default): the refuse list must answer 403
//   --refuse-file                 the file that rm would delete; it must still exist afterwards
//   --clipped-pane/--clipped-term a blocked dialog in a pane so small that only its last rows are visible: must be refused
//   --idle-pane/--idle-term       an agent that is not blocked: must be refused with 409 not_blocked
//   NODE_USE_SYSTEM_CA=1 node scripts/decision-proof.js --base https://x.trycloudflare.com --session default ... --out docs/e2e-decision.json
// The bearer token is read from the 0600 token file and never printed or written. The saved receipt holds pass/fail,
// status codes, error codes and the source/Herdr identity: no screen text, pane ids, session names or addresses.
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('../lib/config');
const receipt = require('./receipt-identity');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
// Refused before the token file is read or any request is made.
for (const k of ['accept-pane', 'accept-term']) if (args[k] !== undefined) { console.error(`refused: --${k} would have this proof answer a folder-trust dialog. That decision is the owner's; the scenario no longer exists.`); process.exit(2); }
for (const k of ['refuse-pane', 'refuse-term', 'refuse-file', 'clipped-pane', 'clipped-term', 'idle-pane', 'idle-term', 'out']) if (!args[k]) { console.error('missing --' + k); process.exit(2); }
const base = (args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const S = args.session || 'default';
const token = fs.readFileSync(config.tokenFile, 'utf8').trim(); // honors HERDR_PORTAL_STATE_DIR, like the server
const out = { started_at: new Date().toISOString(), identity: null, steps: [], results: {} };
let failed = 0;
const step = (name, ok, info = {}) => { if (!ok) failed += 1; out.steps.push({ name, ok, at: new Date().toISOString(), ...info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); return ok; };

async function call(method, p, body) {
  const t0 = Date.now();
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json, ms: Date.now() - t0 };
}
const decision = (pane, term, option, tag) => {
  const request_id = `req-dec-${tag}-${crypto.randomUUID().slice(0, 8)}`;
  return { request_id, send: () => call('POST', '/api/herdr/agent_decision', { session: S, pane_id: pane, expect_terminal_id: term, option, request_id, idempotency_key: `idem-dec-${tag}-${crypto.randomUUID()}` }) };
};
const screen = async (pane) => (await call('GET', `/api/herdr/pane_read?session=${S}&pane_id=${pane}&source=visible`)).json.result.read.text;
const status = async (pane) => (await call('GET', `/api/herdr/agent_get?session=${S}&pane_id=${pane}`)).json.result.agent.agent_status;
// The dialog itself: from its top rule to the end of the screen. Spinners/timers in the chat area above may change.
const lines = (t) => t.split('\n').map((l) => l.trimEnd()).filter(Boolean);
const block = (t) => { const l = lines(t); let i = l.length - 1; for (; i >= 0 && !/^[─━═]{10,}$/.test(l[i].trim()); i--); return l.slice(Math.max(i, 0)).join('\n'); };

(async () => {
  const OPT = 'Yes';
  const hl = await call('GET', '/api/health'); const pg = await call('GET', '/api/herdr/ping');
  out.identity = receipt.make({ served: hl.json && hl.json.build, herdrVersion: hl.json && hl.json.herdr && hl.json.herdr.installed_version, protocol: pg.json && pg.json.sessions && pg.json.sessions[0] && pg.json.sessions[0].protocol });

  // ---- 1. live: the refuse list, on a real `rm` permission dialog ----
  const rPane = args['refuse-pane']; const rTerm = args['refuse-term'];
  const rBefore = await screen(rPane); const rSt = await status(rPane);
  step('refuse pane is blocked on a real Bash permission dialog for rm -f', rSt === 'blocked' && /rm -f /.test(rBefore) && /❯\s*1\.\s*Yes/.test(rBefore) && /4\.\s*No/.test(rBefore), { agent_status: rSt });
  const d2 = decision(rPane, rTerm, OPT, 'refuse'); const r2 = await d2.send();
  const e2 = (r2.json && r2.json.error) || {};
  step('refuse list: 403 escalate_to_owner, category deletion', r2.status === 403 && e2.code === 'escalate_to_owner' && e2.reason === 'escalate_to_owner' && e2.category === 'deletion', { http: r2.status, code: e2.code, category: e2.category });
  const d2b = decision(rPane, rTerm, 'No', 'refuse-no'); const r2b = await d2b.send();
  step('even the safe-looking option "No" is refused (the whole dialog is the owner\'s)', r2b.status === 403 && r2b.json.error.code === 'escalate_to_owner', { http: r2b.status });
  const rAfter = await screen(rPane); const rStAfter = await status(rPane);
  step('refused dialog is untouched: still blocked, cursor still on "1. Yes", the file rm would delete still exists', rStAfter === 'blocked' && /❯\s*1\.\s*Yes/.test(rAfter) && block(rAfter) === block(rBefore) && fs.existsSync(args['refuse-file']), { agent_status: rStAfter, dialog_block_identical_to_before: block(rAfter) === block(rBefore), file_exists: fs.existsSync(args['refuse-file']) });

  // ---- 2. live: a dialog clipped by a tiny pane cannot be checked, so it is refused ----
  const cPane = args['clipped-pane']; const cBefore = await screen(cPane);
  const d2c = decision(cPane, args['clipped-term'], OPT, 'clipped'); const r2c = await d2c.send();
  const cAfter = await screen(cPane);
  step('clipped dialog (small pane, top not visible): refused, nothing sent, dialog untouched', [422].includes(r2c.status) && ['dialog_incomplete', 'dialog_not_recognized'].includes(r2c.json.error.code) && block(cAfter) === block(cBefore) && (await status(cPane)) === 'blocked', { http: r2c.status, code: r2c.json.error.code });

  // ---- 3. live: an agent that is not blocked is refused ----
  const d3 = decision(args['idle-pane'], args['idle-term'], OPT, 'notblocked'); const r3 = await d3.send();
  step('agent that is not blocked: 409 not_blocked, nothing sent', r3.status === 409 && r3.json.error.code === 'not_blocked', { http: r3.status, code: r3.json.error.code });

  // ---- 4. audit_tail shows all of it ----
  const tail = await call('GET', '/api/herdr/audit_tail?n=50');
  const by = (id) => (tail.json.entries || []).find((e) => e.request_id === id);
  const a2 = by(d2.request_id); const a2b = by(d2b.request_id); const a3 = by(d3.request_id); const a2c = by(d2c.request_id);
  step('audit_tail returns the refusal (result rejected, http 403, escalate_to_owner, deletion)', tail.status === 200 && !!a2 && a2.action === 'herdr.agent_decision' && a2.pane === rPane && a2.option && a2.option.label === OPT && a2.result === 'rejected' && a2.http_status === 403 && a2.error_code === 'escalate_to_owner' && a2.category === 'deletion');
  step('audit_tail also returns the other refusals', !!a2b && a2b.http_status === 403 && !!a2c && a2c.http_status === 422 && !!a3 && a3.http_status === 409 && a3.error_code === 'not_blocked');
  const order = (tail.json.entries || []).map((e) => e.timestamp);
  step('entries are in time order and every line carries a timestamp', order.every((t, i) => /^\d{4}-/.test(t) && (i === 0 || order[i - 1] <= t)), { count: tail.json.count });

  const ok = (names) => out.steps.filter((s) => names.some((n) => s.name.startsWith(n))).every((s) => s.ok);
  const at = new Date().toISOString();
  out.results['herdr.agent_decision'] = { ok: ok(['refuse', 'even the safe', 'refused dialog', 'clipped dialog', 'agent that is not']), at };
  out.results['herdr.audit_tail'] = { ok: ok(['audit_tail', 'entries are in time order']), at };
  out.finished_at = at; out.ok = failed === 0;
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('proof error:', e.message); process.exit(1); });
