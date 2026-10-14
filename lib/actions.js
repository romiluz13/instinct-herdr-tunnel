'use strict';
// The allowlist. Every entry maps to ONE known Herdr operation with a fixed input schema.
// `proof` is consumed by scripts/gen-proof-matrix.js, which checks the schema pointer, the forwarded parameter
// names (`forwards`) and the CLI command against the installed binary. That check is evidence only: it never
// changes what runs. The only runtime switch is `proof.verified === false`, which dispatch() refuses (404
// action_disabled) unless the entry names an `optInEnv` variable that the operator set to 1.
const herdr = require('./herdr');
const { ApiError, RE, T, validate, AGENT_KEYS } = require('./validate');
const { payloadHash } = require('./ledger');
const { config } = require('./config');
const { putFile } = require('./dropbox');
const { parseDialog, resolveOption, movesTo, inverse, refuseReason, looksTruncated } = require('./dialog');

const DOC = {
  cli: 'https://herdr.dev/docs/cli-reference/',
  sock: 'https://herdr.dev/docs/socket-api/',
  auto: 'https://herdr.dev/docs/agent-automation/',
};

// Kinds documented in CLI reference > Agents (agent start).
const AGENT_KINDS = ['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp', 'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo', 'qodercli', 'qwen', 'letta', 'maki', 'muse'];
const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const READ_SOURCES = ['visible', 'detection']; // recent / recent-unwrapped are refused (can scroll full-screen agents)

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
    summary: 'Passive pane read: source visible (default) or detection, plain text',
    params: { ...S, pane_id: T.str(RE.pane), source: T.enum(READ_SOURCES, { optional: true }), lines: T.int(1, 500, { optional: true }) },
    proof: { sock: 'pane.read', forwards: { required: ['pane_id', 'source', 'format', 'strip_ansi'], optional: ['lines'] }, docs: [[DOC.cli, 'Read sources'], [DOC.auto, 'Alternate-screen history reads'], [DOC.sock, 'Reading panes']], note: 'recent/recent_unwrapped refused by portal policy' },
    async run(ctx, p) {
      const params = { pane_id: p.pane_id, source: p.source || 'visible', format: 'text', strip_ansi: true };
      if (p.lines) params.lines = p.lines;
      const r = await readCall(ctx, p.session, 'pane.read', params);
      const text = r.result?.read?.text;
      if (typeof text === 'string' && text.length > 65536) r.result.read.text = text.slice(-65536);
      return { ...r, source: params.source };
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
        const prev = ctx.locks.get(lockKey) || Promise.resolve();
        let release; const gate = new Promise((r) => { release = r; });
        const tail = prev.then(() => gate);
        ctx.locks.set(lockKey, tail);
        await prev;
        try {
          await assertTargetCompatible(ctx, p.session, actionName);
          const { pane, sock } = await preflight(ctx, kind, p, { agentStatuses, keys: p.keys });
          const prep = prepare ? await prepare(ctx, sock, pane, p) : undefined;
          const target = { session: p.session, pane_id: p.pane_id, terminal_id: pane.terminal_id, agent: pane.agent || null, agent_status_at_preflight: pane.agent_status || null, cwd: pane.cwd || null };
          const started_at = iso();
          try { ctx.ledger.begin({ request_id, idempotency_key, payload_hash: hash, action: actionName, session: p.session, target, started_at }); }
          catch (e) { throw new ApiError(503, 'ledger_unavailable', 'cannot record the request durably; nothing was sent'); }
          let rec;
          try {
            const detail = await exec(ctx, sock, p, prep);
            rec = { request_id, idempotency_key, payload_hash: hash, action: actionName, session: p.session, target, started_at, finished_at: iso(), status: detail.status || okStatus, detail: detail.detail || {} };
          } catch (e) {
            const c = anyErrorUncertain && anyErrorUncertain(p) ? { status: 'needs_review', detail: { error: e.code || 'error', message: String(e.message).slice(0, 200), note: 'The prompt is submitted before the wait starts: delivery is likely. Inspect the pane; do not retry blindly.' } } : classify(e);
            rec = { request_id, idempotency_key, payload_hash: hash, action: actionName, session: p.session, target, started_at, finished_at: iso(), status: c.status, detail: c.detail };
          }
          try { return ctx.ledger.finish(rec); }
          catch (e) { // result could not be persisted: report uncertainty and never allow a re-send under this key
            const unsure = { ...rec, t: 'done', status: 'needs_review', detail: { error: 'ledger_write_failed', original_status: rec.status } };
            ctx.ledger.byKey.set(idempotency_key, { hash, state: 'done', record: unsure });
            return unsure;
          }
        } finally { release(); tail.then(() => { if (ctx.locks.get(lockKey) === tail) ctx.locks.delete(lockKey); }); }
      })();
      ctx.ledger.inflight.set(idempotency_key, { hash, promise: run });
      try { const rec = await run; return recordBody(rec, request_id, false); }
      finally { ctx.ledger.inflight.delete(idempotency_key); }
    },
  };
}

const recordBody = (rec, request_id, replayed) => ({
  ok: rec.status === 'input_sent' || rec.status === 'agent_started',
  request_id, original_request_id: rec.request_id, idempotency_key: rec.idempotency_key, replayed,
  action: rec.action, status: rec.status, target: rec.target, started_at: rec.started_at, finished_at: rec.finished_at, detail: rec.detail,
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
    summary: 'Submit a prompt to an idle/done agent; optional bounded wait for lifecycle settle', kind: 'agent', agentStatuses: ['idle', 'done'],
    anyErrorUncertain: (p) => !!p.wait_timeout_ms,
    params: { text: T.prompt(8000), wait_timeout_ms: T.int(1000, config.maxWaitMs, { optional: true }), wait_until: T.enumList(['idle', 'done'], 2, { optional: true }) },
    proof: { sock: 'agent.prompt', forwards: { required: ['target', 'text'], optional: ['wait'] }, docs: [[DOC.cli, 'Agents'], [DOC.auto, 'Choose the control surface']] },
    async exec(ctx, sock, p) {
      const params = { target: p.pane_id, text: p.text };
      if (p.wait_timeout_ms) params.wait = { timeout_ms: p.wait_timeout_ms, ...(p.wait_until ? { until: p.wait_until } : {}) };
      const r = await herdr.call(sock, 'agent.prompt', params, { timeoutMs: (p.wait_timeout_ms || 0) + 10000 });
      return { status: 'input_sent', detail: { agent_status_after: r.agent?.agent_status || null, waited: !!p.wait_timeout_ms, task_completed: null } };
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

// Portal-level file drop: writes one UTF-8 file under the drop root and calls no Herdr method. Deliberately outside the
// writeAction path (no pane, no ledger, no Herdr compatibility gate): it must keep answering while Herdr is slow or down.
const uploads = {
  'herdr.put_file': {
    summary: 'Portal-level: write one UTF-8 text file under the drop root (atomic, 0600) and return its path, size and sha256 read back from disk',
    drop: true,
    params: { action: T.enum(['put_file'], { optional: true }), path: T.any(), content: T.any(), sha256: T.any(), mode: T.enum(['create', 'overwrite'], { optional: true }) },
    proof: { portal: true, uses: [], docs: [], native: 'writes one file under the drop root (`lib/dropbox.js`)', note: 'Portal operation, not a Herdr method: writes only under HERDR_PORTAL_DROP_DIR (lib/dropbox.js); calls no Herdr method' },
    async run(ctx, p) {
      if (!ctx.audit.healthy) throw new ApiError(503, 'audit_unavailable', 'the audit log cannot be written; nothing was written');
      return putFile(config.dropDir, p, ctx.dropHooks);
    },
    // One line per call, accepted or refused. Never the content: the path the caller asked for, the resolved path when there is one, sizes and hashes.
    audit(ctx, raw, body, err) {
      const r = raw && typeof raw === 'object' ? raw : {};
      const info = (err && err.info) || {};
      return {
        timestamp: iso(), action: 'herdr.put_file', path: body ? body.path : info.path || null, path_requested: clean(r.path, 200),
        bytes: body ? body.bytes : info.bytes ?? null, sha256: body ? body.sha256 : info.sha256 || null, mode: r.mode === 'overwrite' ? 'overwrite' : 'create',
        result: body ? 'written' : 'rejected', http_status: body ? 200 : err.status || 500, error_code: body ? null : err.code || 'internal',
      };
    },
  },
};

const ACTIONS = { ...reads, ...reconcile, ...writes, ...uploads };
const methodOf = (name) => (writes[name] || reconcile[name] || uploads[name] ? 'POST' : 'GET');

function httpStatusFor(body) {
  if (body && body.status === 'failed') return body.detail && body.detail.error === 'escalate_to_owner' ? 403 : 422;
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
    replayed: body ? !!body.replayed : false,
    request_id: clean(r.request_id, 128), idempotency_key: clean(r.idempotency_key, 128),
  };
  append(ctx, entry);
}

const append = (ctx, entry) => {
  try { ctx.audit.append(entry); }
  catch (e) { process.stderr.write(JSON.stringify({ t: iso(), event: 'audit_write_failed', message: String(e.message).slice(0, 120) }) + '\n'); }
};

async function dispatch(ctx, name, httpMethod, rawParams) {
  const a = ACTIONS[name];
  if (!a) throw new ApiError(404, 'unknown_action', 'unknown action');
  if (methodOf(name) !== httpMethod) throw new ApiError(405, 'method_not_allowed', `${name} requires ${methodOf(name)}`);
  if (a.proof.verified === false && !(a.optInEnv && process.env[a.optInEnv] === '1')) throw new ApiError(404, 'action_disabled', a.disabledMessage || 'action is unverified and disabled');
  const record = a.audit ? (b, e) => append(ctx, a.audit(ctx, rawParams, b, e)) : a.write ? (b, e) => audit(ctx, name, rawParams, b, e) : null;
  let body;
  try {
    const p = validate(a.params, rawParams);
    body = await a.run(ctx, p, name);
  } catch (e) {
    if (record) record(null, e);
    throw e;
  }
  if (record) record(body, null);
  return body;
}

// An authenticated call that failed before dispatch() (body too large, not JSON, not UTF-8): the audit line is still owed.
function recordRefusal(ctx, name, err) {
  const a = ACTIONS[name];
  if (a && a.audit) append(ctx, a.audit(ctx, {}, null, err));
}

module.exports = { ACTIONS, dispatch, recordRefusal, methodOf, httpStatusFor, AGENT_KINDS, STATUSES, READ_SOURCES };
