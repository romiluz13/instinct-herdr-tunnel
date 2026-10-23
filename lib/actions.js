'use strict';
// The allowlist. Every entry maps to ONE known Herdr operation with a fixed input schema.
// `proof` is consumed by scripts/gen-proof-matrix.js, which checks the schema pointer, the forwarded parameter
// names (`forwards`) and the CLI command against the installed binary. That check is evidence only: it never
// changes what runs. The runtime switches are `gate` (an environment variable the owner must set to 1, else 404
// action_disabled) and `proof.verified === false`, which dispatch() refuses (404 action_disabled) unless the entry
// names an `optInEnv` variable that the operator set to 1.
const herdr = require('./herdr');
const { ApiError, RE, T, validate, AGENT_KEYS } = require('./validate');
const crypto = require('crypto');
const { payloadHash } = require('./ledger');
const { config } = require('./config');
const { putFile } = require('./dropbox');
const { parseDialog, resolveOption, movesTo, inverse, refuseReason, looksTruncated } = require('./dialog');
const { gateOpen, capabilities, HISTORY, CONTROL, TAG_PANES } = require('./gates');
const { tagPane } = require('./tag');
const { control } = require('./terminal-control');
const { locate, confirmWord, choiceNear, nonSpaceCount } = require('./screen-guard');
const { readPaneSize, verifiedSize } = require('./pane-size');

const DOC = {
  cli: 'https://herdr.dev/docs/cli-reference/',
  sock: 'https://herdr.dev/docs/socket-api/',
  auto: 'https://herdr.dev/docs/agent-automation/',
};

// Kinds documented in CLI reference > Agents (agent start).
const AGENT_KINDS = ['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse'];
const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const READ_SOURCES = ['visible', 'detection', 'recent', 'recent_unwrapped'];
const HISTORY_SOURCES = new Set(['recent', 'recent_unwrapped']);

const S = { session: T.str(RE.session) };
const WRITE_ENVELOPE = { request_id: T.str(RE.requestId), idempotency_key: T.str(RE.idemKey) };
const TARGET = { session: T.str(RE.session), pane_id: T.str(RE.pane), expect_terminal_id: T.str(RE.terminal) };

const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sockOf = (ctx, name) => {
  const s = ctx.inventory.session(name);
  if (!s || !s.running) throw new ApiError(404, 'unknown_session', `session not found or not running: ${name}`);
  return s.socket_path;
};

async function readCall(ctx, session, method, params, extra = {}) {
  const sock = sockOf(ctx, session);
  try {
    const result = await herdr.call(sock, method, params, extra);
    return { ok: true, session, fetched_at: iso(), result };
  } catch (e) { throw mapHerdrError(e); }
}

function mapHerdrError(e) {
  if (e instanceof ApiError) return e;
  if (e instanceof herdr.HerdrError) {
    const status = /not_found/.test(e.code) ? 404 : e.code.endsWith('timeout') ? 504 : 502;
    return new ApiError(status, `herdr_${e.code}`, e.message.slice(0, 200));
  }
  return e;
}

// ---------- history reads ----------
const HISTORY_CAP = 262144;
const HISTORY_DEFAULT_LINES = 500;
const HISTORY_OFF = `the owner enables history reads with ${HISTORY}=agents (recognized agents) or ${HISTORY}=all (every pane)`;

// What a caller may read, judged from a fresh pane.get. A recognized agent is paged through its own scroll interface by
// Herdr (an active operation), so only an idle or done one is read; a plain pane is read passively but its scrollback can
// hold secrets, hence the wider setting.
function assertHistoryReadable(pane, p, setting) {
  if (p.expect_terminal_id && pane.terminal_id !== p.expect_terminal_id) throw new ApiError(409, 'target_changed', 'pane now hosts a different terminal than expected', { actual_terminal_id: pane.terminal_id });
  if (!pane.agent) {
    if (setting !== 'all') throw new ApiError(403, 'source_disabled', `history of a pane without a recognized agent is off; the owner adds it with ${HISTORY}=all`);
    return;
  }
  if (!['idle', 'done'].includes(pane.agent_status)) throw new ApiError(409, 'history_requires_idle', `agent status is ${pane.agent_status}; history is read only from an idle or done agent. Read visible instead.`, { agent_status: pane.agent_status });
}

async function historyRead(ctx, p) {
  const setting = capabilities().history;
  if (!setting || setting === 'invalid') throw new ApiError(403, 'source_disabled', `${p.source} reads are off; ${HISTORY_OFF}`);
  if (!ctx.audit.healthy) throw new ApiError(503, 'audit_unavailable', 'the audit log cannot be written; nothing was read');
  const getPane = async () => (await readCall(ctx, p.session, 'pane.get', { pane_id: p.pane_id })).result?.pane || {};
  let pane = await getPane();
  assertHistoryReadable(pane, p, setting);
  const lines = p.lines || HISTORY_DEFAULT_LINES;
  const agent = !!pane.agent;
  const params = { pane_id: p.pane_id, source: p.source, format: 'text', strip_ansi: true, lines };
  let r;
  const release = agent ? await lockPane(ctx, `${p.session}/${p.pane_id}`) : null;
  try {
    if (agent) { pane = await getPane(); assertHistoryReadable(pane, p, setting); } // the status may have changed while this request waited
    r = await readCall(ctx, p.session, 'pane.read', params, agent ? { timeoutMs: config.historyTimeoutMs } : {});
  } catch (e) {
    if (agent && e instanceof ApiError && e.status === 504) throw new ApiError(504, 'history_timeout', 'the agent may still be scrolling; read visible before retrying');
    throw e;
  } finally { if (release) release(); }
  const read = r.result?.read || {};
  let text = typeof read.text === 'string' ? read.text : '';
  let truncated = read.truncated === true;
  if (text.length > HISTORY_CAP) { text = text.slice(-HISTORY_CAP); truncated = true; }
  const linesReturned = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length;
  const sc = pane.scroll;
  const history_mode = !sc ? 'unknown'
    : sc.max_offset_from_bottom > 0 ? 'host_scrollback'
      : agent && linesReturned > sc.viewport_rows ? 'agent_scrollback' : 'screen_only';
  if (history_mode === 'screen_only' && lines > sc.viewport_rows) {
    throw new ApiError(409, 'history_unavailable', `this pane has nothing beyond its ${sc.viewport_rows}-row screen; the screen is returned in visible_text`, { history_mode, viewport_rows: sc.viewport_rows, visible_text: text });
  }
  r.result.read = { ...read, text, truncated };
  return { ...r, source: p.source, history_mode, lines_requested: lines, lines_returned: linesReturned, truncated, ...(p.expect_terminal_id ? { checked_terminal_id: p.expect_terminal_id } : {}) };
}

// ---------- reads ----------
const reads = {
  'herdr.ping': {
    summary: 'Portal and per-session Herdr ping', params: { session: T.str(RE.session, { optional: true }) },
    proof: { sock: 'ping', forwards: { required: [] }, docs: [[DOC.sock, 'Socket transport']] },
    async run(ctx, p) {
      const names = p.session ? [p.session] : [...ctx.inventory.sessions.keys()];
      const sessions = [];
      for (const n of names) {
        const s = ctx.inventory.session(n);
        if (!s) { sessions.push({ session: n, ok: false, error: 'unknown_session' }); continue; }
        const t0 = Date.now();
        try { const r = await herdr.call(s.socket_path, 'ping', {}); sessions.push({ session: n, ok: true, version: r.version, protocol: r.protocol, rtt_ms: Date.now() - t0 }); }
        catch (e) { sessions.push({ session: n, ok: false, error: e.code || 'error' }); }
      }
      return { ok: true, fetched_at: iso(), portal: { version: config.version, uptime_s: Math.round(process.uptime()), writes_enabled: ctx.writesEnabled }, sessions };
    },
  },
  'herdr.session_list': {
    summary: 'Discover all local Herdr sessions', params: {},
    proof: { cli: ['session', 'list'], docs: [[DOC.cli, 'Sessions']], note: 'CLI-only; no session.list socket method exists in the installed schema' },
    async run() { try { return { ok: true, fetched_at: iso(), sessions: await herdr.listSessions() }; } catch (e) { throw mapHerdrError(e); } },
  },
  'herdr.session_snapshot': {
    summary: 'Authoritative snapshot of one session', params: S,
    proof: { sock: 'session.snapshot', forwards: { required: [] }, docs: [[DOC.sock, 'Raw methods']] },
    run: (ctx, p) => readCall(ctx, p.session, 'session.snapshot', {}),
  },
  'herdr.workspace_list': { summary: 'List workspaces', params: S, proof: { sock: 'workspace.list', forwards: { required: [] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Workspaces']] }, run: (ctx, p) => readCall(ctx, p.session, 'workspace.list', {}) },
  'herdr.workspace_get': { summary: 'Get a workspace', params: { ...S, workspace_id: T.str(RE.workspace) }, proof: { sock: 'workspace.get', forwards: { required: ['workspace_id'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Workspaces']] }, run: (ctx, p) => readCall(ctx, p.session, 'workspace.get', { workspace_id: p.workspace_id }) },
  'herdr.tab_list': { summary: 'List tabs', params: { ...S, workspace_id: T.str(RE.workspace, { optional: true }) }, proof: { sock: 'tab.list', forwards: { required: [], optional: ['workspace_id'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Tabs']] }, run: (ctx, p) => readCall(ctx, p.session, 'tab.list', p.workspace_id ? { workspace_id: p.workspace_id } : {}) },
  'herdr.tab_get': { summary: 'Get a tab', params: { ...S, tab_id: T.str(RE.tab) }, proof: { sock: 'tab.get', forwards: { required: ['tab_id'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Tabs']] }, run: (ctx, p) => readCall(ctx, p.session, 'tab.get', { tab_id: p.tab_id }) },
  'herdr.pane_list': { summary: 'List panes', params: { ...S, workspace_id: T.str(RE.workspace, { optional: true }) }, proof: { sock: 'pane.list', forwards: { required: [], optional: ['workspace_id'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Panes']] }, run: (ctx, p) => readCall(ctx, p.session, 'pane.list', p.workspace_id ? { workspace_id: p.workspace_id } : {}) },
  'herdr.pane_get': { summary: 'Get a pane', params: { ...S, pane_id: T.str(RE.pane) }, proof: { sock: 'pane.get', forwards: { required: ['pane_id'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Panes']] }, run: (ctx, p) => readCall(ctx, p.session, 'pane.get', { pane_id: p.pane_id }) },
  'herdr.agent_list': { summary: 'List agents', params: S, proof: { sock: 'agent.list', forwards: { required: [] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Agents']] }, run: (ctx, p) => readCall(ctx, p.session, 'agent.list', {}) },
  'herdr.agent_get': { summary: 'Get an agent (target = hosting pane id)', params: { ...S, pane_id: T.str(RE.pane) }, proof: { sock: 'agent.get', forwards: { required: ['target'] }, docs: [[DOC.sock, 'Raw methods'], [DOC.cli, 'Agents']] }, run: (ctx, p) => readCall(ctx, p.session, 'agent.get', { target: p.pane_id }) },
  'herdr.pane_read': {
    summary: 'Pane read, plain text: source visible (default) or detection; recent and recent_unwrapped return history when the owner enabled it',
    params: { ...S, pane_id: T.str(RE.pane), source: T.enum(READ_SOURCES, { optional: true }), lines: T.int(1, 2000, { optional: true }), expect_terminal_id: T.str(RE.terminal, { optional: true }) },
    proof: { sock: 'pane.read', forwards: { required: ['pane_id', 'source', 'format', 'strip_ansi'], optional: ['lines'] }, docs: [[DOC.cli, 'Read sources'], [DOC.auto, 'Alternate-screen history reads'], [DOC.sock, 'Reading panes']], note: 'recent/recent_unwrapped are history reads: off unless HERDR_PORTAL_ENABLE_HISTORY is agents, 1 or all' },
    async run(ctx, p) {
      if (HISTORY_SOURCES.has(p.source)) return historyRead(ctx, p);
      if (p.lines > 500) throw new ApiError(400, 'invalid_param', 'invalid parameter: lines above 500 are for history reads (source=recent or recent_unwrapped)');
      const params = { pane_id: p.pane_id, source: p.source || 'visible', format: 'text', strip_ansi: true };
      if (p.lines) params.lines = p.lines;
      // pane.read's result carries no terminal_id (Herdr 0.9.4 schema), so this is a pane.get precheck: it refuses a
      // terminal that already changed, but a terminal swapped between the two calls is still read.
      if (p.expect_terminal_id) {
        const actual = (await readCall(ctx, p.session, 'pane.get', { pane_id: p.pane_id })).result?.pane?.terminal_id;
        if (actual !== p.expect_terminal_id) throw new ApiError(409, 'target_changed', 'pane now hosts a different terminal than expected', { actual_terminal_id: actual });
      }
      const r = await readCall(ctx, p.session, 'pane.read', params);
      const text = r.result?.read?.text;
      if (typeof text === 'string' && text.length > 65536) r.result.read.text = text.slice(-65536);
      return { ...r, source: params.source, ...(p.expect_terminal_id ? { checked_terminal_id: p.expect_terminal_id } : {}) };
    },
    // History reads only (a screen read polls every 1.5 s): who read how much of which pane, never the text.
    audit(ctx, raw, body, err) {
      const r = raw && typeof raw === 'object' ? raw : {};
      if (!HISTORY_SOURCES.has(r.source)) return null;
      return {
        timestamp: iso(), action: 'herdr.pane_read', session: clean(r.session, 64), pane: clean(r.pane_id, 40), source: r.source,
        history: body ? { mode: body.history_mode, lines_requested: body.lines_requested, lines_returned: body.lines_returned, truncated: body.truncated } : null,
        result: body ? 'read' : 'rejected', http_status: body ? 200 : err.status || 500, error_code: body ? null : err.code || 'internal',
      };
    },
  },
  'herdr.agent_wait': {
    summary: 'Wait for agent lifecycle state (bounded; async)',
    params: { ...S, pane_id: T.str(RE.pane), until: T.enumList(STATUSES, 5, { optional: true }), timeout_ms: T.int(1000, config.maxWaitMs, { optional: true }) },
    proof: { sock: 'agent.wait', forwards: { required: ['target', 'timeout_ms'], optional: ['until'] }, docs: [[DOC.cli, 'Agents'], [DOC.auto, 'Choose the control surface'], [DOC.sock, 'Waiting for state']] },
    async run(ctx, p) {
      if (ctx.waits >= config.maxConcurrentWaits) throw new ApiError(429, 'too_many_waits', 'too many concurrent waits');
      const timeout = p.timeout_ms || 30000;
      ctx.waits += 1;
      try {
        const params = { target: p.pane_id, timeout_ms: timeout };
        if (p.until) params.until = p.until;
        return await readCall(ctx, p.session, 'agent.wait', params, { timeoutMs: timeout + 3000 });
      } finally { ctx.waits -= 1; }
    },
  },
  'herdr.audit_tail': {
    summary: 'Portal-level: last N entries of the manage-action audit log (oldest first)', params: { n: T.int(1, 500, { optional: true }) },
    proof: { portal: true, uses: [], docs: [], note: 'Portal operation, not a Herdr method: reads the portal\'s own append-only audit.jsonl (no Herdr call)' },
    async run(ctx, p) {
      const t = ctx.audit.tail(p.n || 50);
      return { ok: true, fetched_at: iso(), file: 'audit.jsonl', count: t.entries.length, entries: t.entries };
    },
  },
  'herdr.events_snapshot': {
    summary: 'Portal-level: cached inventory with freshness and event-stream state', params: { session: T.str(RE.session, { optional: true }) },
    proof: { portal: true, uses: ['events.subscribe', 'session.snapshot'], docs: [[DOC.sock, 'Event subscriptions']], note: 'Portal operation, not a Herdr method' },
    async run(ctx, p) {
      const v = ctx.inventory.view();
      if (p.session) v.sessions = v.sessions.filter((s) => s.session === p.session);
      return { ok: true, ...v };
    },
  },
};

// ---------- portal-level mutation of the cache only (POST) ----------
const reconcile = {
  'herdr.events_reconcile': {
    summary: 'Portal-level: force authoritative re-read (session.snapshot) and return the fresh inventory', params: { session: T.str(RE.session, { optional: true }) },
    proof: { portal: true, uses: ['session.snapshot'], docs: [[DOC.sock, 'Event subscriptions']], note: 'Portal operation, not a Herdr method; restores current state, not lost history' },
    async run(ctx, p) {
      const names = p.session ? [p.session] : [...ctx.inventory.sessions.keys()];
      for (const n of names) if (!ctx.inventory.session(n)) throw new ApiError(404, 'unknown_session', `unknown session: ${n}`);
      await Promise.all(names.map((n) => ctx.inventory.reconcile(n)));
      const v = ctx.inventory.view();
      if (p.session) v.sessions = v.sessions.filter((s) => s.session === p.session);
      return { ok: true, reconciled_at: iso(), ...v };
    },
  },
};

// ---------- writes ----------
const AMBIGUOUS = new Set(['timeout', 'agent_prompt_stalled', 'agent_not_ready', 'socket_timeout', 'socket_closed', 'bad_response', 'cli_timeout', 'cli_error', 'socket_error']);

const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

async function foregroundIsShell(sock, paneId) {
  const r = await herdr.call(sock, 'pane.process_info', { pane_id: paneId });
  const procs = (r.process_info && r.process_info.foreground_processes) || [];
  const names = procs.map((x) => String(x.argv0 || x.name || '').replace(/^-/, '').split('/').pop());
  return { shell: names.length > 0 && names.every((n) => SHELLS.has(n)), names };
}

// Fresh identity of the session that will receive the input, read after the pane lock is held: a server that was
// upgraded, restarted or replaced while this request waited must not receive input that was never checked. The
// running server must be the build whose schema lib/compat.js read (same version, same protocol), and that schema must
// still fit what this action sends.
async function assertTargetCompatible(ctx, session, actionName) {
  const sock = sockOf(ctx, session);
  if (ctx.refreshCompat) await ctx.refreshCompat(); // one `herdr --version`; re-reads the schema only if the CLI was upgraded since. Before the ping, so the identity read below is not stale.
  let pong;
  try { pong = await herdr.call(sock, 'ping', {}); }
  catch (e) { throw new ApiError(502, `herdr_${e.code || 'error'}`, 'cannot confirm the version of the target session; nothing was sent'); }
  if (!pong || typeof pong.version !== 'string' || typeof pong.protocol !== 'number') throw new ApiError(503, 'writes_disabled', `session ${session} did not report its Herdr version and protocol; nothing was sent`);
  if (!ctx.writesEnabled) throw new ApiError(503, 'writes_disabled', ctx.writesDisabledReason);
  if (pong.version !== ctx.compat.version || pong.protocol !== ctx.compat.protocol) throw new ApiError(503, 'writes_disabled', `running server of session ${session} is ${pong.version} (protocol ${pong.protocol}) but the installed herdr CLI is ${ctx.compat.version} (protocol ${ctx.compat.protocol}); restart that Herdr server; nothing was sent`);
  const c = ctx.compat.actions[actionName];
  if (!c || !c.ok) throw new ApiError(503, 'contract_mismatch', `Herdr ${pong.version} no longer matches what ${actionName} sends (${c ? c.reason : 'unknown action'}); nothing was sent`);
}

async function preflight(ctx, kind, p, rule = {}) {
  const sock = sockOf(ctx, p.session);
  let pane;
  try { pane = (await herdr.call(sock, 'pane.get', { pane_id: p.pane_id })).pane; }
  catch (e) { throw new ApiError(e.code === 'pane_not_found' ? 404 : 502, e.code === 'pane_not_found' ? 'target_not_found' : `herdr_${e.code}`, 'cannot resolve target pane'); }
  if (!pane || pane.pane_id !== p.pane_id) throw new ApiError(409, 'target_ambiguous', 'target pane did not resolve to the requested id');
  if (pane.terminal_id !== p.expect_terminal_id) throw new ApiError(409, 'target_changed', 'pane now hosts a different terminal than expected', { actual_terminal_id: pane.terminal_id });
  const hostsAgent = !!pane.agent;
  if (pane.agent_status === 'blocked' && kind !== 'decision') {
    const grab = async (source) => { try { return String((await herdr.call(sock, 'pane.read', { pane_id: p.pane_id, source, format: 'text', strip_ansi: true })).read?.text || '').slice(-4000); } catch { return null; } };
    const visible = await grab('visible');
    const dlg = visible && parseDialog(visible);
    throw new ApiError(409, 'blocked_requires_decision', 'agent is blocked on a dialog; this action sends nothing. Answer it in Herdr (agent_decision is disabled unless the owner enabled it).', {
      agent_status: 'blocked', agent: pane.agent || null, visible_text: visible, detection_text: await grab('detection'), dialog: dialogView(dlg),
    });
  }
  if (kind === 'decision') {
    if (!hostsAgent) throw new ApiError(409, 'no_agent', 'no detected agent in that pane');
    if (pane.agent_status !== 'blocked') throw new ApiError(409, 'not_blocked', `agent status is ${pane.agent_status}; agent_decision answers only a blocked agent`, { agent_status: pane.agent_status });
  }
  if (kind === 'agent' && !hostsAgent) throw new ApiError(409, 'no_agent', 'no detected agent in that pane');
  // Scroll and click: an agent pane whose screen Herdr cannot classify may be showing a dialog. A plain pane has no status to judge.
  if (kind === 'control' && hostsAgent && pane.agent_status === 'unknown') throw new ApiError(409, 'agent_state_not_writable', 'agent status is unknown; it may be showing a dialog, so the portal sends it nothing', { agent_status: 'unknown' });
  // `unknown` = Herdr cannot classify the screen; a dialog may be showing (seen live: a trust prompt reported as unknown at startup).
  if (kind === 'agent') {
    const ok = rule.agentStatuses || ['idle', 'done', 'working'];
    if (!ok.includes(pane.agent_status)) throw new ApiError(409, 'agent_state_not_writable', `agent status is ${pane.agent_status}; this action writes only to ${ok.join('/')} agents`, { agent_status: pane.agent_status });
  }
  if (kind === 'pane' && hostsAgent) throw new ApiError(409, 'pane_hosts_agent', 'pane hosts a detected agent; use the agent_* actions (pane input would bypass agent state checks)');
  if (kind === 'start' && hostsAgent) throw new ApiError(409, 'pane_hosts_agent', 'pane already hosts an agent');
  if (kind === 'pane') {
    // Herdr may not have classified a freshly started agent yet (its dialog can read as `unknown`): a plain shell in the foreground is the proof that nothing else is listening.
    let fg; try { fg = await foregroundIsShell(sock, p.pane_id); } catch (e) { throw new ApiError(502, 'foreground_unknown', 'cannot determine the foreground process of the pane'); }
    const safeKeys = rule.keys && rule.keys.every((k) => AGENT_KEYS.has(String(k).toLowerCase()));
    if (!fg.shell && !safeKeys) throw new ApiError(409, 'foreground_not_shell', `foreground process is ${fg.names.join(', ') || 'unknown'}, not a shell; only non-confirming keys (esc, ctrl+c, arrows, tab, backspace) may be sent`, { foreground: fg.names });
  }
  return { pane, sock };
}

const dialogView = (d) => (d ? { hash: d.hash, complete: d.framed, options: d.options.map((o) => ({ key: o.key, label: o.label, selected: o.selected })) } : null);
const readVisible = async (sock, paneId) => String(((await herdr.call(sock, 'pane.read', { pane_id: paneId, source: 'visible', format: 'text', strip_ansi: true })).read || {}).text || '');
const escalate = (r) => new ApiError(403, 'escalate_to_owner', `the dialog involves ${r.category.replace(/_/g, ' ')}; the portal never answers it. The owner decides in Herdr.`, { reason: 'escalate_to_owner', category: r.category, matched: r.matched });

function classify(e) {
  if (e instanceof herdr.HerdrError) {
    if (AMBIGUOUS.has(e.code) && !(e.code === 'socket_error' && e.definite)) return { status: 'needs_review', detail: { error: e.code, message: e.message.slice(0, 200), note: 'Outcome uncertain: input may have been sent. Inspect the pane; do not retry blindly.' } };
    return { status: 'failed', detail: { error: e.code, message: e.message.slice(0, 200) } };
  }
  return { status: 'needs_review', detail: { error: 'internal', message: String(e.message).slice(0, 200) } };
}

// One queue per pane: whoever asks first goes first, and the next waits until `release()`. Writes and active history
// reads share it, so a prompt never lands in the middle of a read that is paging the agent.
async function lockPane(ctx, key) {
  const prev = ctx.locks.get(key) || Promise.resolve();
  let free; const gate = new Promise((r) => { free = r; });
  const tail = prev.then(() => gate);
  ctx.locks.set(key, tail);
  await prev;
  return () => { free(); tail.then(() => { if (ctx.locks.get(key) === tail) ctx.locks.delete(key); }); };
}

function writeAction({ summary, kind, params, proof, exec, prepare, okStatus = 'input_sent', agentStatuses, anyErrorUncertain }) {
  return {
    summary, params: { ...TARGET, ...WRITE_ENVELOPE, ...params }, proof, write: true,
    async run(ctx, p, actionName) {
      if (!ctx.writesEnabled && ctx.refreshCompat) await ctx.refreshCompat();
      if (!ctx.writesEnabled) throw new ApiError(503, 'writes_disabled', ctx.writesDisabledReason || 'writes disabled');
      if (!ctx.audit.healthy) throw new ApiError(503, 'audit_unavailable', 'the audit log cannot be written; nothing was sent');
      const { request_id, idempotency_key, ...payload } = p;
      const hash = payloadHash(actionName, payload);
      const flying = ctx.ledger.inflight.get(idempotency_key);
      if (flying) {
        if (flying.hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'idempotency_key was used with a different payload; nothing executed');
        return replayBody(await flying.promise, request_id);
      }
      const seen = ctx.ledger.lookup(idempotency_key);
      if (seen) {
        if (seen.hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'idempotency_key was used with a different payload; nothing executed');
        return replayBody(seen.record, request_id);
      }
      const lockKey = `${p.session}/${p.pane_id}`;
      const run = (async () => {
        const release = await lockPane(ctx, lockKey);
        try {
          await assertTargetCompatible(ctx, p.session, actionName);
          const { pane, sock } = await preflight(ctx, kind, p, { agentStatuses, keys: p.keys });
          const prep = prepare ? await prepare(ctx, sock, pane, p) : undefined;
          const target = { session: p.session, pane_id: p.pane_id, terminal_id: pane.terminal_id, agent: pane.agent || null, agent_status_at_preflight: pane.agent_status || null, cwd: pane.cwd || null };
          const started_at = iso(); const intent_id = crypto.randomUUID();
          const base = { kind: 'pane', intent_id, audit: 'owed', request_id, idempotency_key, payload_hash: hash, action: actionName, session: p.session, target, started_at };
          try { ctx.ledger.begin(base); }
          catch (e) { throw new ApiError(503, 'ledger_unavailable', 'cannot record the request durably; nothing was sent'); }
          let rec;
          try {
            const detail = await exec(ctx, sock, p, prep);
            rec = { ...base, finished_at: iso(), status: detail.status || okStatus, detail: detail.detail || {} };
          } catch (e) {
            const c = anyErrorUncertain && anyErrorUncertain(p, e) ? { status: 'needs_review', detail: { error: e.code || 'error', message: String(e.message).slice(0, 200), note: 'The prompt is submitted before the wait starts: delivery is likely. Inspect the pane; do not retry blindly.' } } : classify(e);
            rec = { ...base, finished_at: iso(), status: c.status, detail: c.detail };
          }
          let done;
          try { done = ctx.ledger.finish(rec); }
          catch (e) { // result could not be persisted: report uncertainty and never allow a re-send under this key
            done = { ...rec, t: 'done', status: 'needs_review', detail: { error: 'ledger_write_failed', original_status: rec.status } };
            ctx.ledger.byKey.set(idempotency_key, { hash, state: 'done', record: done });
          }
          if (gateOpen(TAG_PANES)) tagPane(sock, p.pane_id, actionName, done.status);
          return done;
        } finally { release(); }
      })();
      ctx.ledger.inflight.set(idempotency_key, { hash, promise: run });
      try { const rec = await run; return recordBody(rec, request_id, false); }
      finally { ctx.ledger.inflight.delete(idempotency_key); }
    },
  };
}

const QUEUED_NOTE = 'Submitted while the agent was working. The agent\'s own interface decides whether to queue the prompt or apply it at once; the portal cannot see which. If a wait was asked for, it can end with the turn that was already running, not with this prompt.';

const recordBody = (rec, request_id, replayed) => ({
  ok: rec.status === 'input_sent' || rec.status === 'input_sent_queued' || rec.status === 'agent_started',
  request_id, original_request_id: rec.request_id, idempotency_key: rec.idempotency_key, replayed, intent_id: rec.intent_id || null,
  action: rec.action, status: rec.status, target: rec.target, started_at: rec.started_at, finished_at: rec.finished_at, ...(rec.recovered_at ? { recovered_at: rec.recovered_at } : {}), detail: rec.detail,
  semantics: 'status describes input delivery only; it does not mean the task finished',
});
const replayBody = (rec, request_id) => recordBody(rec, request_id, true);

const writes = {
  'herdr.agent_start': writeAction({
    summary: 'Start a supported agent kind in an existing shell pane (no native args)', kind: 'start', okStatus: 'agent_started',
    params: { name: T.str(RE.agentName), kind: T.enum(AGENT_KINDS), startup_timeout_ms: T.int(3001, 300000, { optional: true }) },
    proof: { sock: 'agent.start', forwards: { required: ['name', 'kind', 'pane_id'], optional: ['timeout_ms'] }, docs: [[DOC.cli, 'Agents'], [DOC.auto, 'Agent identity and launch']] },
    async exec(ctx, sock, p) {
      const params = { name: p.name, kind: p.kind, pane_id: p.pane_id };
      if (p.startup_timeout_ms) params.timeout_ms = p.startup_timeout_ms;
      const r = await herdr.call(sock, 'agent.start', params, { timeoutMs: (p.startup_timeout_ms || 30000) + 5000 });
      return { status: 'agent_started', detail: { agent: r.agent || null } };
    },
  }),
  'herdr.agent_decision': Object.assign(writeAction({
    summary: 'DISABLED BY DEFAULT. Answer a blocked agent\'s dialog by option key/label: arrow keys to the option, verified, then Enter. Refuse list returns 403 escalate_to_owner', kind: 'decision',
    params: { option: T.text(120) },
    proof: { verified: false, sock: 'agent.send_keys', forwards: { required: ['target', 'keys'] }, uses: ['pane.get', 'pane.read'], docs: [[DOC.auto, 'Choose the control surface'], [DOC.cli, 'Agents'], [DOC.sock, 'Raw methods'], [DOC.sock, 'Reading panes']], note: 'dialog parsing, refuse list and the pre-send re-check are portal logic; the only key-sending call is agent.send_keys' },
    // Runs before anything is recorded or sent: a refused or unrecognised dialog consumes no idempotency key.
    async prepare(ctx, sock, pane, p) {
      let text;
      try { text = await readVisible(sock, p.pane_id); } catch (e) { throw new ApiError(502, 'dialog_unreadable', 'cannot read the pane to find the dialog; nothing was sent'); }
      const dialog = parseDialog(text);
      if (!dialog) throw new ApiError(422, 'dialog_not_recognized', 'no single-select option list with a cursor was found on screen; nothing was sent. Answer it in Herdr.');
      // A dialog whose top border is off screen may hide the very text the refuse list must see: never answer it.
      if (!dialog.framed) throw new ApiError(422, 'dialog_incomplete', 'the top of the dialog is not visible (pane too small, or an unframed dialog), so it cannot be checked; nothing was sent. Enlarge the pane or answer it in Herdr.', { dialog: dialogView(dialog) });
      if (looksTruncated(dialog.scan)) throw new ApiError(422, 'dialog_incomplete', 'the dialog elides part of its content ("+N lines", "ctrl+o to expand"), so it cannot be checked; nothing was sent. Answer it in Herdr.', { dialog: dialogView(dialog) });
      const refuse = refuseReason(dialog.scan, p.option, pane.cwd);
      if (refuse) throw escalate(refuse);
      const r = resolveOption(dialog, p.option);
      if (r.error) throw new ApiError(r.error === 'option_ambiguous' ? 409 : 422, r.error, r.error === 'option_ambiguous' ? 'more than one option matches; use the number or the full label' : 'no option with that exact key or label is on screen', { dialog: dialogView(dialog) });
      return { dialog, option: r.option };
    },
    async exec(ctx, sock, p, { dialog, option }) {
      const sent = [];
      const abort = (error, extra = {}) => ({ status: 'failed', detail: { error, confirmed: false, keys_sent: sent.slice(), dialog_hash: dialog.hash, ...extra } });
      // Everything the answer depends on, re-read: same terminal, still blocked, same dialog (cursor-independent
      // fingerprint), refuse list clean, and optionally the highlight on the wanted option.
      const recheck = async (needCursor) => {
        let pane; let d;
        try { pane = (await herdr.call(sock, 'pane.get', { pane_id: p.pane_id })).pane; d = parseDialog(await readVisible(sock, p.pane_id)); }
        catch (e) { return { fail: abort('recheck_failed', { herdr_error: e.code || 'error' }) }; }
        if (!pane || pane.terminal_id !== p.expect_terminal_id) return { fail: abort('target_changed') };
        if (pane.agent_status !== 'blocked') return { fail: abort('no_longer_blocked', { agent_status: pane.agent_status }) };
        if (!d || d.hash !== dialog.hash || !d.framed) return { fail: abort('dialog_changed', { dialog: dialogView(d) }) };
        if (looksTruncated(d.scan)) return { fail: abort('dialog_changed', { dialog: dialogView(d) }) };
        const refuse = refuseReason(d.scan, option.label, pane.cwd);
        if (refuse) return { fail: abort('escalate_to_owner', refuse) };
        if (needCursor && d.cursor !== option.index) return { fail: abort('cursor_not_on_option', { cursor: d.cursor }) };
        return { dialog: d };
      };
      const moves = movesTo(dialog, option.index);
      if (moves.length) {
        const r0 = await recheck(false); if (r0.fail) return r0.fail;
        await herdr.call(sock, 'agent.send_keys', { target: p.pane_id, keys: moves }); sent.push(...moves);
        // An abort after the cursor was moved leaves the highlight displaced for whoever answers in Herdr next:
        // put it back (arrow keys only, never Enter) if the same dialog is still blocked.
        const undo = async (fail) => {
          const back = await recheck(false);
          if (back.fail) { fail.detail.cursor_restored = false; return fail; }
          try { await herdr.call(sock, 'agent.send_keys', { target: p.pane_id, keys: inverse(moves) }); fail.detail.cursor_restored = true; fail.detail.restore_keys_sent = inverse(moves); }
          catch { fail.detail.cursor_restored = false; }
          return fail;
        };
        let ok = false; let last = null;
        for (let i = 0; i < 12 && !ok; i++) { // wait until the highlight is on the wanted option; Enter is never sent before that
          await sleep(120);
          const r = await recheck(true);
          if (!r.fail) ok = true; else if (r.fail.detail.error !== 'cursor_not_on_option') return undo(r.fail); else last = r.fail;
        }
        if (!ok) return undo(last);
      } else {
        const r = await recheck(true); if (r.fail) return r.fail;
      }
      await herdr.call(sock, 'agent.send_keys', { target: p.pane_id, keys: ['enter'] }); sent.push('enter');
      // Confirm the effect: the dialog should be gone (or replaced by a different one).
      let after = { agent_status: null, cleared: false, next: null };
      for (let i = 0; i < 10 && !after.cleared; i++) {
        await sleep(200);
        try {
          const pane = (await herdr.call(sock, 'pane.get', { pane_id: p.pane_id })).pane;
          const d = parseDialog(await readVisible(sock, p.pane_id));
          after = { agent_status: pane.agent_status || null, cleared: !d || d.hash !== dialog.hash, next: d && d.hash !== dialog.hash ? d.hash : null };
        } catch { break; }
      }
      const base = { option: { index: option.index, key: option.key, label: option.label }, keys_sent: sent, dialog_hash: dialog.hash, confirmed: true, agent_status_after: after.agent_status, dialog_cleared: after.cleared, next_dialog_hash: after.next };
      if (!after.cleared) return { status: 'needs_review', detail: { ...base, error: 'outcome_unverified', note: 'Enter was sent but the same dialog is still on screen (or could not be re-read). Inspect the pane; do not retry blindly.' } };
      return { status: 'input_sent', detail: base };
    },
  }), {
    // Granting a trust, permission or auto-mode dialog is the owner's decision. The caller names only an option, not the
    // dialog it looked at, so a delayed request can land on a replacement dialog; the keyword refuse list is no proof of
    // safety. Off unless the operator sets the variable to 1 (see docs/agent-decision.md).
    optInEnv: 'HERDR_PORTAL_ENABLE_AGENT_DECISION',
    disabledMessage: 'agent_decision is disabled: answering a trust or permission dialog is the owner\'s decision. Answer it in Herdr.',
  }),
  'herdr.agent_prompt': writeAction({
    summary: 'Submit a prompt to an idle/done/working agent (a working one answers input_sent_queued); optional bounded wait for lifecycle settle', kind: 'agent', agentStatuses: ['idle', 'done', 'working'],
    anyErrorUncertain: (p, e) => !!p.wait_timeout_ms && e.code !== 'agent_blocked', // Herdr sends nothing and starts no wait for a blocked agent
    params: { text: T.prompt(8000), wait_timeout_ms: T.int(1000, config.maxWaitMs, { optional: true }), wait_until: T.enumList(['idle', 'done'], 2, { optional: true }) },
    proof: { sock: 'agent.prompt', forwards: { required: ['target', 'text'], optional: ['wait'] }, uses: ['pane.read'], docs: [[DOC.cli, 'Agents'], [DOC.auto, 'Choose the control surface']] },
    // A working agent can raise a dialog at any moment and the text would answer it. Herdr rejects a prompt for an agent it
    // already classifies as blocked; this read closes part of the gap before Herdr's classification catches up. It runs
    // before anything is recorded, so a refusal consumes no idempotency key.
    async prepare(ctx, sock, pane, p) {
      if (pane.agent_status !== 'working') return { queued: false };
      await readScreenUnlessDialog(sock, p.pane_id, 'sends');
      return { queued: true };
    },
    async exec(ctx, sock, p, { queued }) {
      const params = { target: p.pane_id, text: p.text };
      if (p.wait_timeout_ms) params.wait = { timeout_ms: p.wait_timeout_ms, ...(p.wait_until ? { until: p.wait_until } : {}) };
      const r = await herdr.call(sock, 'agent.prompt', params, { timeoutMs: (p.wait_timeout_ms || 0) + 10000 });
      const detail = { agent_status_after: r.agent?.agent_status || null, waited: !!p.wait_timeout_ms, task_completed: null };
      return queued ? { status: 'input_sent_queued', detail: { ...detail, note: QUEUED_NOTE } } : { status: 'input_sent', detail };
    },
  }),
  'herdr.agent_send_keys': writeAction({
    summary: 'Send non-confirming logical keys (esc, ctrl+c, arrows, tab, backspace) to an agent UI', kind: 'agent',
    params: { keys: T.agentKeys(16) },
    proof: { sock: 'agent.send_keys', forwards: { required: ['target', 'keys'] }, docs: [[DOC.cli, 'Agents'], [DOC.cli, 'Panes']] },
    async exec(ctx, sock, p) { await herdr.call(sock, 'agent.send_keys', { target: p.pane_id, keys: p.keys }); return { status: 'input_sent', detail: { keys: p.keys } }; },
  }),
  'herdr.pane_send_text': writeAction({
    summary: 'Send literal text (no Enter) to a non-agent pane', kind: 'pane',
    params: { text: T.text(2000) },
    proof: { sock: 'pane.send_text', forwards: { required: ['pane_id', 'text'] }, docs: [[DOC.cli, 'Panes'], [DOC.sock, 'Raw methods']] },
    async exec(ctx, sock, p) { await herdr.call(sock, 'pane.send_text', { pane_id: p.pane_id, text: p.text }); return { status: 'input_sent', detail: { chars: p.text.length } }; },
  }),
  'herdr.pane_send_keys': writeAction({
    summary: 'Send validated keys to a non-agent pane', kind: 'pane',
    params: { keys: T.keys(16) },
    proof: { sock: 'pane.send_keys', forwards: { required: ['pane_id', 'keys'] }, docs: [[DOC.cli, 'Panes'], [DOC.sock, 'Raw methods']] },
    async exec(ctx, sock, p) { await herdr.call(sock, 'pane.send_keys', { pane_id: p.pane_id, keys: p.keys }); return { status: 'input_sent', detail: { keys: p.keys } }; },
  }),
  'herdr.pane_run': writeAction({
    summary: 'Submit a command line (text + Enter) to a non-agent pane; passed as data, never run by the portal', kind: 'pane',
    // `herdr pane run` takes <COMMAND>... and does not treat `--` as a terminator (observed 2026-10-13: the `--` was typed
    // into the shell), so a leading `-` could be read as a CLI flag. Shell command lines never start with one.
    params: { text: T.text(2000, { noLeadingDash: true }) },
    proof: { cli: ['pane', 'run'], docs: [[DOC.cli, 'Panes'], [DOC.auto, 'Choose the control surface']], note: 'CLI-only; there is no pane.run socket method in the installed schema' },
    async exec(ctx, sock, p) {
      const session = ctx.inventory.session(p.session);
      await herdr.cli(['--session', session.name, 'pane', 'run', p.pane_id, p.text]);
      return { status: 'input_sent', detail: { chars: p.text.length } };
    },
  }),
};

// ---------- control: scroll and click through a terminal controller ----------
const WHEEL_LINES = 3; // lines per wheel step; a wheel-driven app moves one notch per command whatever this is
const STOP_NOTE = 'The controller was stopped at its deadline: a mouse button may still be pressed. Inspect the pane; do not retry blindly.';
const UNSURE_NOTE = 'Outcome uncertain: input may have been sent. Inspect the pane; do not retry blindly.';

// Runs one controller and turns what it did into a ledger outcome. A definite failure (nothing delivered) is `failed`;
// anything doubtful, including a pane whose size moved during the call, is `needs_review`.
async function runControl(ctx, sock, p, prep, commands, detail) {
  const session = ctx.inventory.session(p.session);
  let res;
  try { res = await control({ session: session.name, terminalId: p.expect_terminal_id, cols: prep.size.cols, rows: prep.size.rows, commands }); }
  catch (e) {
    if (e instanceof ApiError && e.code === 'too_many_controllers') return { status: 'failed', detail: { error: e.code, message: e.message } };
    throw e;
  }
  const seen = { frames: res.frames, elapsed_ms: res.elapsed_ms, records: res.records };
  if (res.outcome === 'not_started') return { status: 'failed', detail: { error: 'controller_unavailable', message: `herdr could not be started (${res.reason}); nothing was sent` } };
  if (res.outcome === 'busy') return { status: 'failed', detail: { error: 'controller_busy', message: 'another controller owns this terminal (the owner\'s or another client\'s); the portal never takes it over; nothing was sent', ...seen } };
  if (res.outcome === 'refused') return { status: 'failed', detail: { error: 'controller_refused', message: 'Herdr refused the controller; nothing was sent', reason: String(res.reason || '').slice(0, 200), ...seen } };
  if (res.outcome === 'uncertain') return { status: 'needs_review', detail: { error: 'controller_uncertain', message: String(res.reason || '').slice(0, 200), killed: res.killed, note: res.killed ? STOP_NOTE : UNSURE_NOTE, ...seen } };
  // sent: the terminal must still have the size it had; a controller forces its own size, and a wrong one re-renders the owner's agent
  let after = null; let viewport = null;
  try {
    after = await readPaneSize(sock, p.pane_id);
    viewport = (await herdr.call(sock, 'pane.get', { pane_id: p.pane_id })).pane?.scroll?.viewport_rows;
  } catch { /* unreadable below */ }
  const same = after && after.rows === prep.size.rows && after.cols === prep.size.cols && viewport === prep.size.rows;
  if (!same) return { status: 'needs_review', detail: { error: 'size_changed', message: after ? `the pane's terminal is now ${after.rows}x${after.cols}, was ${prep.size.rows}x${prep.size.cols}` : 'the pane\'s size could not be read after the call', resized: after ? true : 'unknown', note: UNSURE_NOTE, ...seen } };
  return { status: 'input_sent', detail: { ...detail, resized: false, elapsed_ms: res.elapsed_ms } };
}

// The text is checked against the screen and never stored: it appears in no response, ledger row or audit line.
const CLICK_TEXT = { optional: false, check: (v) => T.text(120).check(v) && nonSpaceCount(v) >= 2 };
const clickRefusal = (category, matched) => new ApiError(403, 'escalate_to_owner', `the click involves ${category.replace(/_/g, ' ')}; the portal never answers a confirm or refuse choice. The owner decides in Herdr.`, { reason: 'escalate_to_owner', category, matched });

// Only a dialog in a format parseDialog knows is caught here; pane_click's row guards then judge the clicked row and its neighbours, pane_scroll has none.
async function readScreenUnlessDialog(sock, paneId, verb) {
  let text;
  try { text = await readVisible(sock, paneId); } catch { throw new ApiError(502, 'screen_unreadable', 'cannot read the pane; nothing was sent'); }
  const dialog = parseDialog(text);
  if (dialog) throw new ApiError(409, 'dialog_on_screen', `the pane shows a dialog; the portal ${verb} nothing while one is open. The owner answers it in Herdr.`, { dialog: dialogView(dialog) });
  return text;
}

const SCROLL_NOTE = 'The pane stays scrolled for its owner until it is moved back. Use direction "bottom" (pane to bottom) when you are done.';
const position = (m) => ({ offset_from_bottom: m.offset_from_bottom, max_offset_from_bottom: m.max_offset_from_bottom });

// A missing method is a definite refusal (nothing moved); the wheel path is never a fallback because it would not move
// Herdr's scrollback and the caller would believe it had.
async function hostScroll(sock, p, before) {
  const steps = p.direction === 'bottom' ? null : p.steps || 1;
  const delta = p.direction === 'up' ? WHEEL_LINES * steps : -WHEEL_LINES * steps;
  const offset = p.direction === 'bottom' ? 0 : Math.max(0, Math.min(before.max_offset_from_bottom, before.offset_from_bottom + delta));
  let res;
  try { res = await herdr.call(sock, 'pane.scroll', { pane_id: p.pane_id, offset_from_bottom: offset }); }
  catch (e) {
    if (e instanceof herdr.HerdrError && e.definite && /method|unsupported/.test(e.code)) return { status: 'failed', detail: { error: 'scroll_unsupported', message: 'this Herdr has no pane.scroll; nothing was moved' } };
    throw e;
  }
  const after = res.pane && res.pane.scroll;
  if (!after) return { status: 'needs_review', detail: { error: 'bad_response', message: 'Herdr did not report the new scroll position', note: UNSURE_NOTE } };
  return { status: 'input_sent', detail: { delivered_as: 'host_scrollback', direction: p.direction, steps, scroll_before: position(before), scroll_after: position(after), note: SCROLL_NOTE } };
}

const scrollAndClick = {
  'herdr.pane_scroll': Object.assign(writeAction({
    summary: 'OFF BY DEFAULT (HERDR_PORTAL_ENABLE_CONTROL=1). Scroll a pane that is not an agent: Herdr scrollback by offset, or wheel events through a terminal controller; up, down or bottom', kind: 'control',
    params: { direction: T.enum(['up', 'down', 'bottom']), steps: T.int(1, 50, { optional: true }) },
    proof: { cli: ['terminal', 'session', 'control'], uses: ['pane.get', 'pane.process_info', 'pane.read', 'pane.scroll'], docs: [[DOC.cli, 'Direct terminal attach'], [DOC.sock, 'Raw methods'], [DOC.auto, 'Alternate-screen history reads']], note: 'terminal.scroll and pane.scroll are not in the prose docs: shapes pinned by scripts/e2e-control.js' },
    async prepare(ctx, sock, pane, p) {
      if (pane.agent) throw new ApiError(409, 'use_history_read', 'this pane hosts a recognized agent; scrolling it would stop Herdr from reading its history. Read it with pane_read source=recent_unwrapped.');
      // Herdr scrollback to move: the socket moves it by absolute offset. No controller, so no size to verify.
      if (pane.scroll && pane.scroll.max_offset_from_bottom > 0) return { host: pane.scroll };
      if (p.direction === 'bottom') throw new ApiError(422, 'bottom_unsupported', 'a pane with no Herdr scrollback is scrolled by wheel events, which have no "bottom"; scroll down, or read visible');
      const size = verifiedSize(await readPaneSize(sock, p.pane_id), pane);
      await readScreenUnlessDialog(sock, p.pane_id, 'scrolls');
      return { size };
    },
    async exec(ctx, sock, p, prep) {
      if (prep.host) return hostScroll(sock, p, prep.host);
      const steps = p.steps || 1;
      const commands = [...Array(steps)].map(() => ({ type: 'terminal.scroll', direction: p.direction, lines: WHEEL_LINES })).concat({ type: 'terminal.release' });
      return runControl(ctx, sock, p, prep, commands, { delivered_as: 'wheel_events', direction: p.direction, steps });
    },
  }), { gate: CONTROL }),
  'herdr.pane_click': Object.assign(writeAction({
    summary: 'OFF BY DEFAULT (HERDR_PORTAL_ENABLE_CONTROL=1). Click one cell of a pane, only if expect_text is still under it; refuses rows that look like a dialog choice or hold a confirm or refuse word (best effort, see docs/control.md)', kind: 'control',
    params: { column: T.int(0, 1000), row: T.int(0, 1000), button: T.enum(['left', 'right'], { optional: true }), expect_text: CLICK_TEXT },
    proof: { cli: ['terminal', 'session', 'control'], uses: ['pane.get', 'pane.process_info', 'pane.read'], docs: [[DOC.cli, 'Direct terminal attach'], [DOC.sock, 'Reading panes']], note: 'terminal.mouse is in the CLI reference; the click guard (screen text, cell mapping, confirm words) is portal logic' },
    async prepare(ctx, sock, pane, p) {
      if (pane.agent) {
        if (capabilities().agent_click !== true) throw new ApiError(409, 'agent_click_disabled', 'clicks on a pane that hosts an agent are off; the owner can enable them with HERDR_PORTAL_ENABLE_AGENT_CLICK=1 (it needs HERDR_PORTAL_ENABLE_CONTROL=1 too)');
        // A working agent can raise a permission dialog between the screen read and the click.
        if (!['idle', 'done'].includes(pane.agent_status)) throw new ApiError(409, 'agent_state_not_writable', `agent status is ${pane.agent_status}; a click goes only to an idle or done agent`, { agent_status: pane.agent_status });
      }
      const named = confirmWord(p.expect_text);
      if (named) throw clickRefusal('confirm_word', named);
      const size = verifiedSize(await readPaneSize(sock, p.pane_id), pane);
      if (p.column >= size.cols || p.row >= size.rows) throw new ApiError(422, 'out_of_bounds', `the terminal is ${size.rows} rows by ${size.cols} columns; cells count from 0`, { rows: size.rows, cols: size.cols });
      const text = await readScreenUnlessDialog(sock, p.pane_id, 'clicks');
      const rows = text.split('\n');
      const row = rows[p.row] || '';
      const hit = locate(row, p.expect_text, p.column);
      if (hit.status === 'screen_changed') throw new ApiError(409, 'screen_changed', 'that text is not under that cell any more; the row is returned so you can decide again', { row: p.row, row_text: row.slice(0, 500) });
      if (hit.status === 'row_not_cell_mappable') throw new ApiError(422, 'row_not_cell_mappable', 'the row holds wide, combining or emoji characters at or before that text, so a column cannot be mapped to it safely; nothing was sent', { row: p.row });
      const onRow = confirmWord(row);
      if (onRow) throw clickRefusal('confirm_word', onRow);
      const choice = choiceNear(rows, p.row);
      if (choice) throw clickRefusal('dialog_choice', choice);
      const refuse = refuseReason(row, p.expect_text, pane.cwd);
      if (refuse) throw clickRefusal(refuse.category, refuse.matched);
      return { size };
    },
    async exec(ctx, sock, p, prep) {
      const button = p.button || 'left';
      const at = { column: p.column, row: p.row };
      const commands = [{ type: 'terminal.mouse', action: 'down', button, ...at }, { type: 'terminal.mouse', action: 'up', button, ...at }, { type: 'terminal.release' }];
      return runControl(ctx, sock, p, prep, commands, { delivered_as: 'mouse_click', button, ...at });
    },
  }), { gate: CONTROL }),
};

// Portal-level file drop: writes one UTF-8 file under the drop root and calls no Herdr method. Deliberately outside the
// writeAction path (no pane, no ledger, no Herdr compatibility gate): it must keep answering while Herdr is slow or down.
const uploads = {
  'herdr.put_file': {
    summary: 'Portal-level: write one UTF-8 text file under the drop root (atomic, 0600) and return its path, size and sha256 read back from disk',
    drop: true,
    params: { action: T.enum(['put_file'], { optional: true }), path: T.any(), content: T.any(), sha256: T.any(), mode: T.enum(['create', 'overwrite'], { optional: true }) },
    proof: { portal: true, uses: [], docs: [], native: 'writes one file under the drop root (`lib/dropbox.js`)', note: 'Portal operation, not a Herdr method: writes only under HERDR_PORTAL_DROP_DIR (lib/dropbox.js); calls no Herdr method' },
    // The ledger gets an intent row (fsync) just before the first change on disk and an outcome row after it. A done
    // row that cannot be written leaves the outcome unrecorded, so a written file is then reported committed_unverified.
    async run(ctx, p) {
      if (!ctx.audit.healthy) throw new ApiError(503, 'audit_unavailable', 'the audit log cannot be written; nothing was written');
      const intent_id = crypto.randomUUID(); let row = null;
      const intent = (info) => {
        const r = { kind: 'file', intent_id, audit: 'owed', action: 'herdr.put_file', path: info.path, mode: p.mode === 'overwrite' ? 'overwrite' : 'create', bytes: info.bytes, sha256: info.sha256, started_at: iso() };
        try { ctx.ledger.begin(r); } catch { throw Object.assign(new ApiError(503, 'ledger_unavailable', 'cannot record the request durably; nothing was written'), { info }); }
        row = r;
      };
      const outcome = (status, extra) => { try { ctx.ledger.finish({ ...row, finished_at: iso(), status, ...extra }); return true; } catch { return false; } };
      let body;
      try { body = await putFile(config.dropDir, p, ctx.dropHooks, intent); }
      catch (e) {
        if (!row) throw e;
        e.intent_id = intent_id;
        if (e.code === 'committed_unverified') { e.extra.intent_id = intent_id; outcome('committed_unverified', { reason: e.extra.reason }); }
        else outcome('rejected', { error_code: e.code || 'internal' });
        throw e;
      }
      if (!outcome('written', { bytes: body.bytes, sha256: body.sha256 })) {
        const cu = new ApiError(500, 'committed_unverified', 'the file was written but its outcome could not be recorded; inspect it before retrying', { committed: true, verified: false, retryable: false, reason: 'ledger_unrecorded', path: body.path, sha256: body.sha256, bytes: body.bytes, observed_sha256: body.sha256, observed_bytes: body.bytes, intent_id });
        throw Object.assign(cu, { info: { path: body.path, bytes: body.bytes, sha256: body.sha256 }, intent_id });
      }
      return { ...body, intent_id };
    },
    // One line per call, accepted or refused. Never the content: the path the caller asked for, the resolved path when there is one, sizes and hashes.
    audit(ctx, raw, body, err) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const info = (err && err.info) || {};
      return {
        timestamp: iso(), action: 'herdr.put_file', path: body ? body.path : info.path || null, path_requested: clean(r.path, 200),
        bytes: body ? body.bytes : info.bytes ?? null, sha256: body ? body.sha256 : info.sha256 || null, mode: r.mode === 'overwrite' ? 'overwrite' : 'create',
        result: body ? 'written' : err.code === 'committed_unverified' ? 'committed_unverified' : 'rejected', http_status: body ? 200 : err.status || 500, error_code: body ? null : err.code || 'internal',
        intent_id: body ? body.intent_id : err.intent_id || null, ...(err && err.code === 'committed_unverified' ? { reason: err.extra.reason, ...(err.extra.observed_sha256 ? { observed_sha256: err.extra.observed_sha256, observed_bytes: err.extra.observed_bytes } : {}) } : {}),
      };
    },
  },
};

const ACTIONS = { ...reads, ...reconcile, ...writes, ...scrollAndClick, ...uploads };
const methodOf = (name) => (writes[name] || scrollAndClick[name] || reconcile[name] || uploads[name] ? 'POST' : 'GET');

// A failed write sent nothing; its HTTP status says why. Anything not listed is a refusal of the request itself (422).
const FAILED_STATUS = { escalate_to_owner: 403, controller_busy: 409, controller_refused: 502, controller_unavailable: 502, too_many_controllers: 429 };
function httpStatusFor(body) {
  if (body && body.status === 'failed') return (body.detail && FAILED_STATUS[body.detail.error]) || 422;
  if (body && body.status === 'needs_review') return 502;
  return 200;
}

// One audit line per manage action, including refusals and rejected requests. Never the text of a prompt or command
// the caller sent; for agent_decision the chosen dialog option (a label from the agent's own screen) is recorded.
const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, n) : null); // also line separators and bidi controls, which a log viewer would act on
function audit(ctx, name, raw, body, err) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = body && body.detail ? body.detail : {};
  const entry = {
    timestamp: iso(), action: name, session: clean(r.session, 64), pane: clean(r.pane_id, 40),
    option: name === 'herdr.agent_decision' ? (d.option || (clean(r.option, 120) === null ? null : { index: null, key: null, label: clean(r.option, 120) })) : null,
    result: body ? body.status : 'rejected',
    http_status: body ? httpStatusFor(body) : err.status || 500,
    error_code: body ? d.error || null : err.code || 'internal',
    category: (err && err.extra && err.extra.category) || d.category || null,
    ...(name === 'herdr.pane_scroll' ? { scroll: { direction: clean(r.direction, 8), steps: Number.isInteger(r.steps) ? r.steps : r.direction === 'bottom' ? null : 1, delivered_as: d.delivered_as || null } } : {}),
    ...(name === 'herdr.pane_click' ? { click: { button: r.button === 'right' ? 'right' : 'left', column: Number.isInteger(r.column) ? r.column : null, row: Number.isInteger(r.row) ? r.row : null, delivered_as: d.delivered_as || null } } : {}),
    replayed: body ? !!body.replayed : false,
    request_id: clean(r.request_id, 128), idempotency_key: clean(r.idempotency_key, 128), intent_id: body && !body.replayed ? body.intent_id : null,
  };
  return append(ctx, entry);
}

// The audit line for an owed ledger outcome, built from the ledger row alone (boot reconcile). reconciled:true marks it.
function reconciledAudit(row) {
  const d = row.detail || {};
  const common = { timestamp: iso(), action: row.action, result: row.status, http_status: row.kind === 'file' || row.recovered_at ? null : httpStatusFor(row), error_code: row.recovered_at ? 'portal_restarted_before_result_recorded' : row.error_code || d.error || null, intent_id: row.intent_id, reconciled: true, ...(row.recovered_at ? { recovered: true } : {}) };
  if (row.kind === 'file') return { ...common, path: row.path || null, bytes: row.bytes ?? null, sha256: row.sha256 || null, mode: row.mode || null };
  return { ...common, session: row.session || null, pane: (row.target && row.target.pane_id) || null, option: null, category: d.category || null, replayed: false, request_id: row.request_id || null, idempotency_key: row.idempotency_key || null };
}

const append = (ctx, entry) => {
  if (!entry) return true;
  try { ctx.audit.append(entry); return true; }
  catch (e) { process.stderr.write(JSON.stringify({ t: iso(), event: 'audit_write_failed', message: String(e.message).slice(0, 120) }) + '\n'); return false; }
};

// After the audit line of a new outcome lands, the ledger gets its ack; if the line could not be written the outcome
// stays owed (boot reconcile writes it) and the caller is told audit:"deferred".
function settle(ctx, record, body, err) {
  const written = record(body, err);
  const id = body ? !body.replayed && body.intent_id : err && err.intent_id;
  if (!id) return;
  if (!written) { if (body) body.audit = 'deferred'; else if (err.extra) err.extra.audit = 'deferred'; return; }
  try { ctx.ledger.audited(id); } catch { /* still owed: reconciled again at boot, a duplicate line at worst */ }
}

async function dispatch(ctx, name, httpMethod, rawParams) {
  const a = ACTIONS[name];
  if (!a) throw new ApiError(404, 'unknown_action', 'unknown action');
  if (methodOf(name) !== httpMethod) throw new ApiError(405, 'method_not_allowed', `${name} requires ${methodOf(name)}`);
  if (a.gate && !gateOpen(a.gate)) throw new ApiError(404, 'action_disabled', `${name} is off; the owner enables it with ${a.gate}=1`);
  if (a.proof.verified === false && !(a.optInEnv && process.env[a.optInEnv] === '1')) throw new ApiError(404, 'action_disabled', a.disabledMessage || 'action is unverified and disabled');
  const record = a.audit ? (b, e) => append(ctx, a.audit(ctx, rawParams, b, e)) : a.write ? (b, e) => audit(ctx, name, rawParams, b, e) : null;
  let body;
  try {
    const p = validate(a.params, rawParams);
    body = await a.run(ctx, p, name);
  } catch (e) {
    if (record) settle(ctx, record, null, e);
    throw e;
  }
  if (a.audit && !a.drop) { // a read: its text is returned only once its audit line is written; put_file settles with the ledger below
    if (!record(body, null)) throw new ApiError(503, 'audit_unavailable', 'the audit log cannot be written; the read is not returned');
  } else if (record) settle(ctx, record, body, null);
  return body;
}

// An authenticated call that failed before dispatch() (body too large, not JSON, not UTF-8): the audit line is still owed.
function recordRefusal(ctx, name, err) {
  const a = ACTIONS[name];
  if (a && a.audit) append(ctx, a.audit(ctx, {}, null, err));
}

module.exports = { ACTIONS, dispatch, recordRefusal, reconciledAudit, methodOf, httpStatusFor, AGENT_KINDS, STATUSES, READ_SOURCES };
