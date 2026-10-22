#!/usr/bin/env node
'use strict';
// One smoke call per allowlisted action against the REAL Herdr, via the portal. Writes only go to the
// isolated test pane you pass in. The saved receipt feeds docs/proof-matrix.md and keeps only pass/fail, a timestamp
// and the source/Herdr identity: the notes printed below (ids, panes, counts) are never saved. The token is read
// locally and never printed.
//   node scripts/smoke-actions.js --session default --pane w1:p1 --terminal term_x [--agents] --out docs/smoke-results.json
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('../lib/config');
const receipt = require('./receipt-identity');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const base = (args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = fs.readFileSync(config.tokenFile, 'utf8').trim(); // honors HERDR_PORTAL_STATE_DIR, like the server
const S = args.session || 'default'; const PANE = args.pane; const TERM = args.terminal;
const out = { generated_at: new Date().toISOString(), identity: null, results: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, p, body) {
  const res = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
}
const failed = []; const unexercised = [];
const record = (action, ok, note) => { out.results[action] = { ok, at: new Date().toISOString() }; if (!ok) failed.push(action); console.log(`${ok ? 'PASS' : 'FAIL'}  ${action}  ${note}`); };
// An action that never ran gets no result row (the proof matrix then says untested), only a summary entry.
const skip = (actions, why) => { for (const a of actions) { unexercised.push(a); console.log(`UNEXERCISED  ${a}  ${why}`); } };
const WRITES = ['herdr.pane_send_text', 'herdr.pane_send_keys', 'herdr.pane_run'];
const AGENT_WRITES = ['herdr.agent_start', 'herdr.agent_send_keys', 'herdr.agent_prompt'];
// Every exit writes the receipt; a failed or incomplete run exits 1. Only the error class is kept, never its message.
function finish(error) {
  out.summary = { failed, unexercised, ...(error ? { incomplete: true, error: error.name || 'Error' } : {}) };
  out.finished_at = new Date().toISOString();
  fs.writeFileSync(args.out || 'docs/smoke-results.json', JSON.stringify(out, null, 2));
  if (unexercised.length) console.log(`UNEXERCISED (not evidence): ${unexercised.join(', ')}`);
  if (error || failed.length) process.exitCode = 1;
}
const w = (extra) => ({ session: S, pane_id: PANE, expect_terminal_id: TERM, request_id: 'req-smoke-' + crypto.randomUUID().slice(0, 12), idempotency_key: 'idem-smoke-' + crypto.randomUUID(), ...extra });
// Results from two server processes are not one run's evidence.
async function sameInstance() {
  const b = (await call('GET', '/api/health')).json.build;
  if (!b || b.instance_id !== out.identity.served_instance_id) throw Object.assign(new Error('the portal restarted during the run'), { name: 'InstanceChanged' });
}
const visible = async (pane = PANE) => (await call('GET', `/api/herdr/pane_read?session=${S}&pane_id=${pane}&source=visible`)).json.result.read.text;

(async () => {
  const hl = await call('GET', '/api/health'); const herdrVersion = hl.json.herdr.installed_version;
  const pg = await call('GET', '/api/herdr/ping'); out.identity = receipt.make({ herdrVersion, protocol: pg.json.sessions[0] && pg.json.sessions[0].protocol, served: hl.json.build });
  const inv = (await call('GET', '/api/inventory')).json;
  const ws = inv.sessions[0].workspaces[0]; const ws1 = ws.workspace_id; const tab1 = ws.tabs[0].tab_id; const pane1 = PANE || ws.tabs[0].panes[0].pane_id;

  let r = await call('GET', '/api/herdr/ping'); record('herdr.ping', r.status === 200 && r.json.sessions.every((s) => s.ok), `sessions ok: ${r.json.sessions.map((s) => `${s.session} v${s.version} p${s.protocol}`).join(', ')}`);
  r = await call('GET', '/api/herdr/session_list'); record('herdr.session_list', r.status === 200 && r.json.sessions.length >= 1, `${r.json.sessions.length} session(s): ${r.json.sessions.map((s) => s.name + (s.running ? '(running)' : '(stopped)')).join(', ')}`);
  r = await call('GET', `/api/herdr/session_snapshot?session=${S}`); const sn = r.json.result.snapshot; record('herdr.session_snapshot', r.status === 200 && sn.version === herdrVersion, `${sn.workspaces.length} ws / ${sn.tabs.length} tabs / ${sn.panes.length} panes / ${sn.agents.length} agents`);
  r = await call('GET', `/api/herdr/workspace_list?session=${S}`); record('herdr.workspace_list', r.status === 200, `HTTP ${r.status}`);
  r = await call('GET', `/api/herdr/workspace_get?session=${S}&workspace_id=${ws1}`); record('herdr.workspace_get', r.status === 200, `workspace ${ws1}`);
  r = await call('GET', `/api/herdr/tab_list?session=${S}`); record('herdr.tab_list', r.status === 200, `HTTP ${r.status}`);
  r = await call('GET', `/api/herdr/tab_get?session=${S}&tab_id=${tab1}`); record('herdr.tab_get', r.status === 200, `tab ${tab1}`);
  r = await call('GET', `/api/herdr/pane_list?session=${S}`); record('herdr.pane_list', r.status === 200, `HTTP ${r.status}`);
  r = await call('GET', `/api/herdr/pane_get?session=${S}&pane_id=${pane1}`); record('herdr.pane_get', r.status === 200, `pane ${pane1}`);
  r = await call('GET', `/api/herdr/agent_list?session=${S}`); const agent = (r.json.result.agents || []).find((a) => a.pane_id === args['agent-pane']) || (r.json.result.agents || [])[0]; record('herdr.agent_list', r.status === 200, `${r.json.result.agents.length} agents`);
  r = await call('GET', `/api/herdr/agent_get?session=${S}&pane_id=${agent.pane_id}`); record('herdr.agent_get', r.status === 200, `agent at ${agent.pane_id}`);
  r = await call('GET', `/api/herdr/pane_read?session=${S}&pane_id=${pane1}&source=visible`); const r2 = await call('GET', `/api/herdr/pane_read?session=${S}&pane_id=${pane1}&source=detection`);
  record('herdr.pane_read', r.status === 200 && r2.status === 200, 'visible and detection OK');
  r = await call('GET', `/api/herdr/agent_wait?session=${S}&pane_id=${agent.pane_id}&until=idle,done,blocked,working,unknown&timeout_ms=5000`); record('herdr.agent_wait', r.status === 200, `returned status ${r.json.result.agent && r.json.result.agent.agent_status}`);
  r = await call('GET', '/api/herdr/events_snapshot'); record('herdr.events_snapshot', r.status === 200 && r.json.sessions.every((s) => s.event_stream.connected), `event streams connected: ${r.json.sessions.map((s) => s.event_stream.connected).join(',')}`);
  r = await call('POST', '/api/herdr/events_reconcile', {}); record('herdr.events_reconcile', r.status === 200 && r.json.sessions.every((s) => !s.stale), `reconciled_at ${r.json.reconciled_at}`);

  if (!PANE) { skip([...WRITES, ...AGENT_WRITES], 'no --pane given'); await sameInstance(); return finish(); }

  // ---- writes: isolated test pane only ----
  const m = crypto.randomBytes(4).toString('hex');
  r = await call('POST', '/api/herdr/pane_send_text', w({ text: `echo SMOKETEXT_${m}` })); await sleep(700);
  record('herdr.pane_send_text', r.status === 200 && (await visible()).includes(`SMOKETEXT_${m}`), `status ${r.json.status}; text visible at prompt without Enter`);
  r = await call('POST', '/api/herdr/pane_send_keys', w({ keys: ['ctrl+u'] })); await sleep(700);
  record('herdr.pane_send_keys', r.status === 200 && !(await visible()).includes(`SMOKETEXT_${m}`), `status ${r.json.status}; ctrl+u cleared the line`);
  r = await call('POST', '/api/herdr/pane_run', w({ text: `printf 'SMOKERUN_%s\\n' '${m}'` })); await sleep(1200);
  record('herdr.pane_run', r.status === 200 && new RegExp(`^SMOKERUN_${m}\\s*$`, 'm').test(await visible()), `status ${r.json.status}; output line observed`);

  if (args.agents) {
    r = await call('POST', '/api/herdr/agent_start', w({ name: 'portal-smoke', kind: args.kind || 'claude', startup_timeout_ms: 90000 }));
    record('herdr.agent_start', r.status === 200 && r.json.status === 'agent_started', `HTTP ${r.status} status ${r.json.status} ${JSON.stringify(r.json.detail || r.json.error).slice(0, 160)}`);
    let st = null;
    for (let i = 0; i < 30; i++) { // settle: wait for a classified state
      await sleep(1000);
      const g = await call('GET', `/api/herdr/agent_get?session=${S}&pane_id=${PANE}`);
      st = g.json && g.json.result && g.json.result.agent && g.json.result.agent.agent_status;
      if (['idle', 'done', 'blocked'].includes(st)) break;
    }
    console.log('      agent status after start:', st);
    if (st === 'blocked') {
      const p1 = await call('POST', '/api/herdr/agent_prompt', w({ text: 'Reply OK' }));
      const p2 = await call('POST', '/api/herdr/agent_send_keys', w({ keys: ['enter'] }));
      record('blocked-agent-refusal(real)', p1.status === 409 && p2.status === 409 && p1.json.error.code === 'blocked_requires_decision', `prompt ${p1.status}, send_keys ${p2.status}; agent left blocked for the owner's decision`);
      skip(['herdr.agent_prompt', 'herdr.agent_send_keys'], 'agent blocked on a dialog (left untouched)');
    } else {
      r = await call('POST', '/api/herdr/agent_send_keys', w({ keys: ['esc'] })); record('herdr.agent_send_keys', r.status === 200, `status ${r.json.status}`);
      r = await call('POST', '/api/herdr/agent_prompt', w({ text: 'Reply with the single word OK and do nothing else. Do not use any tools.', wait_timeout_ms: 55000 })); record('herdr.agent_prompt', r.status === 200, `status ${r.json.status}; settled ${r.json.detail && r.json.detail.agent_status_after}; task_completed is not claimed`);
    }
  } else skip(AGENT_WRITES, 'no --agents given');
  await sameInstance();
  finish();
})().catch((e) => { console.error('smoke error:', e.message); finish(e); });
