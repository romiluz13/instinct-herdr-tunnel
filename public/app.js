'use strict';
// All dynamic text goes through textContent (never innerHTML). The token lives only in this closure.
(() => {
  let token = null;
  let inv = null;
  let invFetchedAt = 0;
  let unreachable = null;
  let health = null;
  let sel = null; // {session, pane_id}
  let paneRead = null; // {source, text, at, error, terminal_id}
  let readGen = 0; // bumped per read and per selection, so a late answer to an older request is dropped
  const results = [];
  const pending = {}; // per form: {sig, key}
  const $ = (id) => document.getElementById(id);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401) { signOut('Token rejected. Sign in again.'); throw new Error('unauthorized'); }
    return { status: res.status, json };
  }

  // ---------- auth ----------
  function showLogin(msg) {
    $('app').hidden = true; $('login').hidden = false;
    const e = $('login-error'); e.hidden = !msg; e.textContent = msg || '';
    $('token').value = ''; $('token').focus();
  }
  function signOut(msg) { token = null; inv = null; health = null; sel = null; paneRead = null; results.length = 0; showLogin(msg); }

  $('login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = $('token').value.trim(); $('token').value = '';
    token = t;
    try {
      const r = await api('/api/health');
      if (r.status !== 200) throw new Error('rejected');
      $('login').hidden = true; $('app').hidden = false;
      await pollOnce(); renderResults();
    } catch (e) { if (token) { token = null; showLogin('Could not sign in. Check the token and try again.'); } }
  });
  $('logout').addEventListener('click', () => signOut());
  $('refresh').addEventListener('click', async () => {
    try { const r = await api('/api/herdr/events_reconcile', { method: 'POST', body: {} }); if (r.json && r.json.ok) { inv = r.json; invFetchedAt = Date.now(); unreachable = null; render(); } } catch { /* shown by poll */ }
  });

  // ---------- polling ----------
  async function pollOnce() {
    try {
      const [i, hl] = await Promise.all([api('/api/inventory'), api('/api/health')]);
      if (i.json && i.json.ok) { inv = i.json; invFetchedAt = Date.now(); unreachable = null; }
      if (hl.json && hl.json.ok) health = hl.json;
    } catch (e) { if (token) unreachable = 'Portal unreachable (Mac asleep, off or offline?). Showing the last data received.'; }
    render();
  }
  setInterval(() => { if (token && !document.hidden) pollOnce(); }, 5000);
  setInterval(() => { if (token) renderFresh(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (token && !document.hidden) pollOnce(); });

  // ---------- render ----------
  const ago = (ms) => (ms == null ? 'never' : ms < 1500 ? 'just now' : ms < 90000 ? Math.round(ms / 1000) + 's ago' : Math.round(ms / 60000) + 'm ago');
  const chip = (s) => h('span', { class: 'chip', data: { s: s || 'unknown' } }, s || 'no agent');

  function renderFresh() {
    if (!inv) return;
    const age = Date.now() - invFetchedAt;
    const anyStale = inv.sessions.some((s) => s.stale) || unreachable || age > 20000;
    const f = $('fresh'); f.className = 'fresh' + (anyStale ? ' stale' : '');
    f.textContent = (anyStale ? 'Stale: ' : 'Updated ') + ago(age) + ' · polled every 5s';
  }

  function renderPills() {
    const p = $('pills'); p.replaceChildren();
    if (unreachable) { p.append(h('span', { class: 'pill bad' }, 'portal unreachable')); return; }
    if (!health) return;
    const pill = (label, cls) => h('span', { class: 'pill ' + cls }, label);
    p.append(pill('portal up', 'ok'));
    p.append(health.tunnel && health.tunnel.up ? pill('tunnel up', 'ok') : pill('tunnel not confirmed', 'warn'));
    p.append(health.herdr.reachable_sessions === health.herdr.total_sessions && health.herdr.total_sessions > 0
      ? pill(`herdr ${health.herdr.reachable_sessions}/${health.herdr.total_sessions} sessions`, 'ok') : pill(`herdr ${health.herdr.reachable_sessions}/${health.herdr.total_sessions} sessions`, 'bad'));
    p.append(health.data.stale ? pill('data stale', 'warn') : pill('data fresh', 'ok'));
    p.append(health.herdr.writes_enabled ? pill('writes on', 'ok') : pill('writes off', 'bad'));
  }

  function renderBanner() {
    const b = $('banner'); const msgs = [];
    if (unreachable) msgs.push(unreachable);
    if (inv) for (const g of inv.gaps) msgs.push((g.session ? g.session + ': ' : '') + g.gap);
    b.hidden = msgs.length === 0; b.replaceChildren(...msgs.map((m) => h('div', {}, m)));
  }

  function renderTree() {
    const t = $('tree'); const openKeys = new Set([...t.querySelectorAll('details[open]')].map((d) => d.dataset.k));
    t.replaceChildren();
    if (!inv) return;
    t.append(h('p', { class: 'sessmeta' }, `${inv.totals.sessions} session(s) · ${inv.totals.workspaces} workspaces · ${inv.totals.tabs} tabs · ${inv.totals.panes} panes · ${inv.totals.agents} agents`));
    for (const s of inv.sessions) {
      const key = 's:' + s.session;
      const d = h('details', { class: 'sess', data: { k: key } },
        h('summary', {}, `${s.session}${s.default ? ' (default)' : ''}`),
        h('div', { class: 'sessmeta' + (s.stale ? ' stale' : '') }, s.accessible ? `${s.stale ? 'stale' : 'fresh'} · v${s.version} · events ${s.event_stream.connected ? 'connected' : 'down'}` : `not accessible: ${s.last_error || 'unknown'}`));
      if (openKeys.has(key) || openKeys.size === 0) d.open = true;
      for (const w of s.workspaces || []) {
        const wk = key + '/' + w.workspace_id;
        const wd = h('details', { class: 'ws', data: { k: wk } }, h('summary', {}, `${w.workspace_id} ${w.label || ''}`, ' ', chip(w.agent_status)));
        if (openKeys.has(wk) || openKeys.size === 0) wd.open = true;
        for (const tab of w.tabs) {
          for (const p of tab.panes) {
            const cur = sel && sel.session === s.session && sel.pane_id === p.pane_id;
            wd.append(h('button', { type: 'button', class: 'pane-btn', 'aria-current': cur ? 'true' : null, onclick: () => selectPane(s.session, p.pane_id) },
              h('span', { class: 't', title: p.cwd || '' }, `${p.pane_id} ${p.agent_name || p.agent || 'shell'} — ${p.title || p.cwd || ''}`), chip(p.agent ? p.agent_status : null)));
          }
        }
        d.append(wd);
      }
      t.append(d);
    }
  }

  const findPane = () => {
    if (!inv || !sel) return null;
    const s = inv.sessions.find((x) => x.session === sel.session);
    for (const w of (s && s.workspaces) || []) for (const t of w.tabs) for (const p of t.panes) if (p.pane_id === sel.pane_id) return { s, w, p };
    return null;
  };

  async function selectPane(session, pane_id) {
    sel = { session, pane_id }; paneRead = null; readGen += 1; render();
    await readPane('visible');
  }

  // read-guard:start
  // The server checks the terminal with pane.get before pane.read; the two calls are not atomic, so a terminal
  // swapped between them is still read. Herdr's read result echoes the pane but not the terminal.
  function readVerdict(want, now, body) {
    if (now.gen !== want.gen || !now.sel || now.sel.session !== want.session || now.sel.pane_id !== want.pane_id) return 'drop';
    if (!body || !body.ok) return 'error';
    const echoed = body.result && body.result.read && body.result.read.pane_id;
    if (body.session !== want.session || echoed !== want.pane_id || body.checked_terminal_id !== want.terminal_id) return 'mismatch';
    return 'show';
  }
  // read-guard:end

  async function readPane(source) {
    const f = findPane();
    if (!sel || !f) return;
    const want = { gen: ++readGen, session: sel.session, pane_id: sel.pane_id, terminal_id: f.p.terminal_id };
    const r = await api(`/api/herdr/pane_read?session=${encodeURIComponent(want.session)}&pane_id=${encodeURIComponent(want.pane_id)}&source=${source}&expect_terminal_id=${encodeURIComponent(want.terminal_id)}`);
    const v = readVerdict(want, { gen: readGen, sel }, r.json);
    if (v === 'drop') return;
    paneRead = v === 'show' ? { source, text: r.json.result.read.text, at: r.json.fetched_at, terminal_id: want.terminal_id }
      : v === 'mismatch' ? { source, error: 'the answer does not match the selected session, pane and terminal; read again' }
        : { source, error: r.json ? `${r.json.error.code}: ${r.json.error.message}` : `HTTP ${r.status}` };
    renderDetail();
  }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());

  // Same content => same idempotency key, so a double click or retry replays instead of re-sending.
  function keyFor(form, sig) {
    if (!pending[form] || pending[form].sig !== sig) pending[form] = { sig, key: 'k-' + uuid() };
    return pending[form].key;
  }

  async function write(action, form, payload, sig) {
    const f = findPane();
    if (!f) return;
    const base = { session: sel.session, pane_id: sel.pane_id, expect_terminal_id: f.p.terminal_id, request_id: 'r-' + uuid(), idempotency_key: keyFor(form, sel.session + '|' + sel.pane_id + '|' + action + sig) };
    const body = { ...base, ...payload };
    let r;
    try { r = await api('/api/herdr/' + action.replace('herdr.', ''), { method: 'POST', body }); }
    catch (e) { // connection dropped: the portal may have executed it. Keep the idempotency key so a retry replays instead of re-sending.
      if (!token) return;
      results.unshift({ at: new Date().toISOString(), action, http: 0, body: { ok: false, status: 'needs_review', error: { code: 'connection_lost', message: 'Connection dropped before a result arrived. The input may have been sent. Check the pane; retrying the same form reuses the same key and is safe.' } }, req: base });
      renderResults(); return;
    }
    const j = r.json || { ok: false, error: { code: 'http_' + r.status, message: 'non-JSON response' } };
    results.unshift({ at: new Date().toISOString(), action, http: r.status, body: j, req: base });
    if (j.ok || j.status === 'failed' || j.status === 'needs_review') pending[form] = null;
    renderResults(); await pollOnce(); if (sel) readPane((paneRead && paneRead.source) || 'visible');
    setTimeout(() => { if (token && sel) readPane((paneRead && paneRead.source) || 'visible'); }, 900); // output of a just-sent command lands after the first read
  }

  function confirmButton(label, confirmLabel, onGo, disabled) {
    const b = h('button', { type: 'button', class: 'primary', disabled }, label);
    let armed = false; let timer;
    b.addEventListener('click', () => {
      if (!armed) { armed = true; b.textContent = confirmLabel; timer = setTimeout(() => { armed = false; b.textContent = label; }, 5000); return; }
      clearTimeout(timer); armed = false; b.textContent = label; b.disabled = true; onGo().finally(() => { b.disabled = disabled; });
    });
    return b;
  }

  function renderDetail() {
    const d = $('detail'); const f = findPane();
    const keep = {}; d.querySelectorAll('[data-keep]').forEach((e) => { keep[e.dataset.keep] = e.value; });
    d.replaceChildren();
    if (!sel) { d.append(h('p', { class: 'muted' }, 'Select a pane to read it or send input.')); return; }
    if (!f) { d.append(h('p', { class: 'error' }, `Pane ${sel.pane_id} in session ${sel.session} is no longer in the inventory.`)); return; }
    const { s, p } = f;
    const blocked = p.agent_status === 'blocked';
    const input = (name, label, kind = 'input', ph = '') => h('div', {}, h('label', { for: 'f-' + name }, label),
      kind === 'textarea' ? h('textarea', { id: 'f-' + name, 'data-keep': name, placeholder: ph }, keep[name] || '') : h('input', { id: 'f-' + name, 'data-keep': name, value: keep[name] || '', placeholder: ph, autocomplete: 'off', spellcheck: 'false' }));
    const val = (n) => ($('f-' + n) ? $('f-' + n).value : '');

    d.append(h('h2', {}, `${s.session} / ${p.pane_id}`, ' ', chip(p.agent ? p.agent_status : null)),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Agent'), h('dd', {}, p.agent ? `${p.agent_name || p.agent} (${p.agent})` : 'none — plain terminal'),
        h('dt', {}, 'Terminal'), h('dd', {}, p.terminal_id),
        h('dt', {}, 'Working dir'), h('dd', {}, p.foreground_cwd || p.cwd || 'unknown'),
        h('dt', {}, 'Snapshot'), h('dd', {}, `${ago(s.snapshot_age_ms)}${s.stale ? ' (stale)' : ''}`)));

    d.append(h('div', { class: 'row' },
      h('button', { type: 'button', onclick: () => readPane('visible') }, 'Read visible'),
      h('button', { type: 'button', onclick: () => readPane('detection') }, 'Read detection'),
      h('span', { class: 'muted' }, 'Only these two sources are allowed; scrollback reads are refused.')));
    if (paneRead && paneRead.terminal_id && paneRead.terminal_id !== p.terminal_id) paneRead = { source: paneRead.source, error: 'the pane now hosts another terminal; this read was from the previous one. Read again.' };
    if (paneRead) {
      d.append(paneRead.error ? h('p', { class: 'error', role: 'alert' }, 'Read failed — ' + paneRead.error)
        : h('div', {}, h('div', { class: 'muted' }, `${paneRead.source} · ${s.session} / ${p.pane_id} · terminal ${paneRead.terminal_id} checked just before the read · read ${paneRead.at}`), h('pre', { class: 'term', tabindex: '0', 'aria-label': 'Pane output' }, paneRead.text || '(empty)')));
    }

    const term = d.querySelector('pre.term'); if (term) term.scrollTop = term.scrollHeight; // newest output is at the bottom
    if (blocked) {
      d.append(h('div', { class: 'blocked-box', role: 'alert' },
        h('strong', {}, 'Blocked: waiting for a decision. '),
        'This agent is showing an approval or question dialog. The portal sends nothing to it and has no way to answer for you. Decide in Herdr; the status updates here within seconds.'));
      return;
    }

    if (p.agent) {
      const g = h('div', { class: 'group' }, h('h2', {}, 'Prompt the agent'),
        input('prompt', 'Prompt', 'textarea', 'What should the agent do?'),
        h('div', { class: 'row' }, h('label', { for: 'f-wait', style: 'margin:0' }, 'Wait for it to settle'),
          h('select', { id: 'f-wait' }, h('option', { value: '0' }, 'no wait'), h('option', { value: '30000' }, 'up to 30s'), h('option', { value: '55000' }, 'up to 55s')),
          h('button', { type: 'button', class: 'primary', onclick: () => { const t = val('prompt'); if (t.trim()) { const w = Number(val('wait') || 0); write('herdr.agent_prompt', 'prompt', { text: t, ...(w ? { wait_timeout_ms: w } : {}) }, t + '|' + w); } } }, 'Send prompt')),
        h('p', { class: 'muted' }, 'A result means the input was delivered, not that the task finished.'));
      d.append(g);
      d.append(h('div', { class: 'group' }, h('h2', {}, 'Agent keys'), input('akeys', 'Keys, space separated (e.g. esc, ctrl+c)'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const k = val('akeys').trim().split(/\s+/).filter(Boolean); if (k.length) write('herdr.agent_send_keys', 'akeys', { keys: k }, k.join(' ')); } }, 'Send keys'),
          h('button', { type: 'button', onclick: () => waitAgent() }, 'Wait for idle/done/blocked (30s)'))));
    } else {
      d.append(h('div', { class: 'group' }, h('h2', {}, 'Run a command in this terminal'), input('cmd', 'Command line (typed and submitted with Enter)', 'input', 'printf hello'),
        h('div', { class: 'row' }, confirmButton('Run', 'Confirm: run in this pane', () => { const t = val('cmd'); return t.trim() ? write('herdr.pane_run', 'cmd', { text: t }, t) : Promise.resolve(); }),
          h('span', { class: 'muted' }, 'The text is sent to the pane; the portal never runs it.'))));
      d.append(h('div', { class: 'group' }, h('h2', {}, 'Send text or keys (no Enter)'), input('txt', 'Text'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const t = val('txt'); if (t) write('herdr.pane_send_text', 'txt', { text: t }, t); } }, 'Send text')),
        input('pkeys', 'Keys, space separated (e.g. enter, ctrl+c)'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const k = val('pkeys').trim().split(/\s+/).filter(Boolean); if (k.length) write('herdr.pane_send_keys', 'pkeys', { keys: k }, k.join(' ')); } }, 'Send keys'))));
      d.append(h('div', { class: 'group' }, h('h2', {}, 'Start an agent here'),
        input('aname', 'Agent name (lowercase letters, digits, - _)'),
        h('div', { class: 'row' }, h('select', { id: 'f-akind', 'aria-label': 'Agent kind' }, ['claude', 'codex', 'pi', 'droid', 'opencode', 'gemini'].map((k) => h('option', { value: k }, k))),
          confirmButton('Start agent', 'Confirm: start agent', () => { const n = val('aname'); return n ? write('herdr.agent_start', 'astart', { name: n, kind: val('akind') }, n + val('akind')) : Promise.resolve(); }))));
    }
  }

  async function waitAgent() {
    const r = await api(`/api/herdr/agent_wait?session=${encodeURIComponent(sel.session)}&pane_id=${encodeURIComponent(sel.pane_id)}&timeout_ms=30000`);
    results.unshift({ at: new Date().toISOString(), action: 'herdr.agent_wait', http: r.status, body: r.json || { ok: false, error: { code: 'http_' + r.status, message: 'non-JSON' } }, req: {} });
    renderResults(); pollOnce();
  }

  function renderResults() {
    const ol = $('results'); ol.replaceChildren(); $('results-empty').hidden = results.length > 0;
    for (const r of results.slice(0, 30)) {
      const b = r.body; const status = b.status || (b.ok ? 'ok' : (b.error ? b.error.code : 'error'));
      const cls = ['input_sent', 'agent_started', 'needs_review', 'failed'].includes(status) ? status : (b.ok ? 'input_sent' : 'rejected');
      ol.append(h('li', {}, h('div', {}, h('span', { class: 'badge ' + cls }, status), ' ', r.action.replace('herdr.', ''), b.replayed ? ' (replayed)' : ''),
        h('div', { class: 'muted' }, `${r.at.slice(11, 19)} · HTTP ${r.http} · ${(b.target && b.target.pane_id) || r.req.pane_id || ''}`),
        b.error ? h('div', { class: 'error' }, b.error.message) : null,
        b.status === 'needs_review' ? h('div', { class: 'error' }, 'Outcome uncertain. Inspect the pane before trying again.') : null,
        h('details', {}, h('summary', {}, 'Details'), h('pre', {}, JSON.stringify(b, null, 2).slice(0, 4000)))));
    }
  }

  // Re-render only what changed, so typing and keyboard focus survive the 5s poll.
  let treeSig = ''; let detailSig = '';
  function render() {
    renderPills(); renderBanner(); renderFresh();
    const tsig = inv ? JSON.stringify(inv.sessions.map((s) => [s.session, s.stale, s.accessible, s.event_stream.connected, s.workspaces, sel && sel.pane_id])) : '';
    if (tsig !== treeSig) { treeSig = tsig; renderTree(); }
    const f = findPane();
    const dsig = JSON.stringify([sel, f ? [f.p.terminal_id, f.p.agent, f.p.agent_status] : null]);
    if (dsig !== detailSig) { detailSig = dsig; renderDetail(); }
  }

  showLogin();
})();
