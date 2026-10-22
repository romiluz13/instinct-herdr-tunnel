#!/usr/bin/env node
'use strict';
// End-to-end proof runner. Works against localhost or the public tunnel URL.
//   node scripts/e2e.js --base https://x.trycloudflare.com --out docs/e2e-public-read.json
//   node scripts/e2e.js --base ... --session default --pane w9:p1 --terminal term_x --out ...   (adds the write round-trip)
//   node scripts/e2e.js --base ... --replay-check docs/e2e-public-write.json                     (after a portal restart)
// The bearer token is read from the 0600 token file and never printed or written to the output.
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('../lib/config');
const receipt = require('./receipt-identity');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const base = (args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = fs.readFileSync(config.tokenFile, 'utf8').trim(); // honors HERDR_PORTAL_STATE_DIR, like the server
const rec = { started_at: new Date().toISOString(), identity: null, steps: [] }; // the base address is not recorded
const step = (name, ok, info = {}) => { rec.steps.push({ name, ok, at: new Date().toISOString(), ...info }); console.log(`${info.skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${info.note ? '  — ' + info.note : ''}`); return ok; };

async function call(method, p, { body, auth = true, tok } = {}) {
  const t0 = Date.now();
  const res = await fetch(base + p, { method, headers: { ...(auth ? { Authorization: 'Bearer ' + (tok || token) } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text, ms: Date.now() - t0 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (args['replay-check']) {
    const prior = JSON.parse(fs.readFileSync(args['replay-check'], 'utf8'));
    const w = prior.write; const sent = w.request;
    const before = await call('GET', `/api/herdr/pane_read?session=${w.session}&pane_id=${w.pane_id}&source=visible`);
    const count = (before.json.result.read.text.match(new RegExp(w.marker_output, 'g')) || []).length;
    const r = await call('POST', '/api/herdr/pane_run', { body: { ...sent, request_id: 'req-after-restart-' + crypto.randomUUID().slice(0, 8) } });
    await sleep(1500);
    const after = await call('GET', `/api/herdr/pane_read?session=${w.session}&pane_id=${w.pane_id}&source=visible`);
    const count2 = (after.json.result.read.text.match(new RegExp(w.marker_output, 'g')) || []).length;
    step('replay after portal restart returns stored result, replayed=true', r.status === 200 && r.json.replayed === true, { status: r.status, replayed: r.json && r.json.replayed, original_request_id: r.json && r.json.original_request_id });
    step('replay after restart sent no additional input (marker count unchanged)', count === count2 && count >= 1, { before: count, after: count2 });
    const c = await call('POST', '/api/herdr/pane_run', { body: { ...sent, text: sent.text + ' ', request_id: 'req-conflict-' + crypto.randomUUID().slice(0, 8) } });
    step('same key with changed payload rejected after restart', c.status === 409 && c.json.error.code === 'idempotency_conflict', { status: c.status });
    rec.finished_at = new Date().toISOString(); rec.ok = rec.steps.every((s) => s.ok);
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(rec, null, 2));
    process.exit(rec.ok ? 0 : 1);
  }

  // --- public surface and auth ---
  const login = await call('GET', '/', { auth: false });
  step('GET / without token serves the login shell (200, no inventory)', login.status === 200 && /Herdr portal/.test(login.text) && !/term_[0-9a-f]{6}/.test(login.text), { status: login.status });
  const noTok = await call('GET', '/api/inventory', { auth: false });
  step('GET /api/inventory without token -> 401, no data', noTok.status === 401 && !/pane_id|session/.test(noTok.text.replace('"unauthorized"', '')), { status: noTok.status });
  const badTok = await call('GET', '/api/herdr/agent_list?session=default', { tok: crypto.randomBytes(32).toString('base64url') });
  step('wrong token -> 401', badTok.status === 401, { status: badTok.status });
  const noTokWrite = await call('POST', '/api/herdr/pane_run', { auth: false, body: { x: 1 } });
  step('write without token -> 401, nothing executed', noTokWrite.status === 401, { status: noTokWrite.status });

  // --- reads ---
  const sessions = await call('GET', '/api/herdr/session_list');
  step('herdr.session_list with valid token', sessions.status === 200 && Array.isArray(sessions.json.sessions), { status: sessions.status, count: sessions.json && sessions.json.sessions.length, fetched_at: sessions.json && sessions.json.fetched_at, ms: sessions.ms });
  const al = await call('GET', '/api/herdr/agent_list?session=default');
  step('herdr.agent_list (session=default)', al.status === 200 && Array.isArray(al.json.result.agents), { status: al.status, session: 'default', agents: al.json && al.json.result.agents.length, fetched_at: al.json && al.json.fetched_at, ms: al.ms });
  const inv = await call('GET', '/api/inventory');
  step('inventory read', inv.status === 200 && inv.json.ok, { status: inv.status, generated_at: inv.json.generated_at, totals: inv.json.totals, sessions: inv.json.sessions.map((s) => ({ session: s.session, accessible: s.accessible, stale: s.stale, snapshot_at: s.snapshot_at, counts: s.counts, version: s.version, protocol: s.protocol })), gaps: inv.json.gaps, ms: inv.ms });
  const ping = await call('GET', '/api/herdr/ping');
  step('herdr.ping', ping.status === 200, { sessions: ping.json && ping.json.sessions });
  const hl = await call('GET', '/api/health');
  rec.identity = receipt.make({ served: hl.json && hl.json.build, herdrVersion: hl.json && hl.json.herdr && hl.json.herdr.installed_version, protocol: ping.json && ping.json.sessions && ping.json.sessions[0] && ping.json.sessions[0].protocol });
  step('health reports portal/tunnel/herdr/data', hl.status === 200, { health: hl.json && { portal: hl.json.portal, tunnel: { up: hl.json.tunnel.up, probe: hl.json.tunnel.probe }, herdr: hl.json.herdr, data: hl.json.data } });
  const lat = []; for (let i = 0; i < 10; i++) lat.push((await call('GET', '/api/inventory')).ms);
  step('measured latency of 10 inventory reads (ms)', true, { latencies_ms: lat, median: lat.slice().sort((a, b) => a - b)[5] });

  // --- forbidden things, against the real Herdr ---
  const firstPane = inv.json.sessions[0].workspaces[0].tabs.find((t) => t.panes.length).panes[0];
  // A history read of a recognized agent pages that agent (active), so this read-only proof asks for one only to see it refused.
  const historyOn = !!(hl.json && hl.json.capabilities && hl.json.capabilities.history);
  if (historyOn) step('pane_read source=recent refusal not probed: history is enabled and a read would page a live agent', true, { skipped: true, note: 'skipped on purpose', capabilities: hl.json.capabilities });
  else {
    const rec1 = await call('GET', `/api/herdr/pane_read?session=default&pane_id=${firstPane.pane_id}&source=recent`);
    step('pane_read source=recent refused while history is off (403 source_disabled)', rec1.status === 403 && rec1.json.error.code === 'source_disabled', { status: rec1.status });
  }
  const rec2 = await call('GET', `/api/herdr/pane_read?session=default&pane_id=${firstPane.pane_id}&source=recent-unwrapped`);
  step('pane_read source=recent-unwrapped refused', rec2.status === 400, { status: rec2.status });
  const bad = await call('GET', '/api/herdr/server_stop');
  step('unknown action refused (404)', bad.status === 404, { status: bad.status });
  const noSess = await call('POST', '/api/herdr/pane_run', { body: { pane_id: 'w1:p1', text: 'x', request_id: 'req-nosess-0001', idempotency_key: 'idem-nosession-0001' } });
  step('write without session refused (400)', noSess.status === 400, { status: noSess.status, code: noSess.json.error.code });

  // --- write round trip ---
  if (args.session && args.pane && args.terminal) {
    const wrong = await call('POST', '/api/herdr/pane_run', { body: { session: args.session, pane_id: args.pane, expect_terminal_id: 'term_deadbeef', text: 'printf WRONG', request_id: 'req-wrongterm-1', idempotency_key: 'idem-wrongterm-' + crypto.randomUUID() } });
    step('write with wrong terminal id refused (409 target_changed)', wrong.status === 409 && wrong.json.error.code === 'target_changed', { status: wrong.status });
    const nonce = crypto.randomBytes(5).toString('hex');
    const text = `printf 'HPPROOF_%s\\n' '${nonce}'`;
    const marker = `HPPROOF_${nonce}`;
    const request = { session: args.session, pane_id: args.pane, expect_terminal_id: args.terminal, text, request_id: 'req-e2e-' + nonce, idempotency_key: 'idem-e2e-' + crypto.randomUUID() };
    const w = await call('POST', '/api/herdr/pane_run', { body: request });
    step('herdr.pane_run -> input_sent', w.status === 200 && w.json.status === 'input_sent', { status: w.status, request_id: w.json.request_id, idempotency_key: request.idempotency_key, target: w.json.target, started_at: w.json.started_at, finished_at: w.json.finished_at });
    let seen = 0; let read;
    for (let i = 0; i < 20 && !seen; i++) { await sleep(500); read = await call('GET', `/api/herdr/pane_read?session=${args.session}&pane_id=${args.pane}&source=visible`); seen = (read.json.result.read.text.match(new RegExp('^' + marker + '\\s*$', 'm')) || []).length; }
    step('herdr.pane_read (visible) shows the one-time marker as command OUTPUT', seen === 1, { fetched_at: read.json.fetched_at, marker, occurrences_as_output_line: seen });
    const again = await call('POST', '/api/herdr/pane_run', { body: { ...request, request_id: 'req-e2e-replay-' + nonce } });
    await sleep(1500);
    const read2 = await call('GET', `/api/herdr/pane_read?session=${args.session}&pane_id=${args.pane}&source=visible`);
    const seen2 = (read2.json.result.read.text.match(new RegExp('^' + marker + '\\s*$', 'm')) || []).length;
    step('replay (same idempotency key) -> replayed=true and no second output line', again.json.replayed === true && seen2 === 1, { replayed: again.json.replayed, original_request_id: again.json.original_request_id, output_lines_after_replay: seen2 });
    rec.write = { session: args.session, pane_id: args.pane, terminal_id: args.terminal, marker_output: marker, request };
  }
  rec.finished_at = new Date().toISOString(); rec.ok = rec.steps.every((s) => s.ok);
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(rec, null, 2));
  console.log(rec.ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(rec.ok ? 0 : 1);
})().catch((e) => { console.error('e2e error:', e.message); process.exit(1); });
