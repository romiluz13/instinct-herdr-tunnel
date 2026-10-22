'use strict';
// All dynamic text goes through textContent (never innerHTML). The token lives only in this closure.
(() => {
  let token = null;
  let inv = null;
  let invFetchedAt = 0;
  let unreachable = null;
  let health = null;
  let sel = null; // {session, pane_id}
  let view = null; // the viewer of the selected pane: built once per pane and terminal, updated in place (see openViewer)
  let readGen = 0; // bumped per read and per selection, so a late answer to an older request is dropped
  const results = [];
  const pending = {}; // per form: {sig, key}
  const $ = (id) => document.getElementById(id);
  const V = window.HerdrViewer;

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

  async function api(path, { method = 'GET', body, signal } = {}) {
    const res = await fetch(path, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal,
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
  function signOut(msg) { token = null; inv = null; health = null; sel = null; closeViewer(); results.length = 0; showLogin(msg); }

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
  document.addEventListener('visibilitychange', () => { if (token && !document.hidden) { pollOnce(); if (view && view.mode === 'screen' && !view.click.cell) loadView(); } });

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
    const t = $('tree'); const openKeys = new Set([...t.querySelectorAll('details')].filter((d) => d.open).map((d) => d.dataset.k));
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

  function selectPane(session, pane_id) {
    sel = { session, pane_id }; readGen += 1; render();
    if (view) loadView();
    const d = $('detail');
    // Below 1000px the pane tree stacks above the viewer, so a tap would otherwise leave the output off screen.
    if (d && d.scrollIntoView && window.matchMedia && window.matchMedia('(max-width:1000px)').matches) d.scrollIntoView({ block: 'start' });
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
    renderResults(); await pollOnce(); if (view) loadView();
    setTimeout(() => { if (token && view) loadView(); }, 900); // output of a just-sent command lands after the first read
    return results[0];
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
    const head = $('pane-head'); const ctl = $('pane-controls');
    const keep = {}; ctl.querySelectorAll('[data-keep]').forEach((e) => { keep[e.dataset.keep] = e.value; });
    head.replaceChildren(); ctl.replaceChildren();
    const f = findPane();
    $('detail-empty').hidden = !!sel; $('viewer').hidden = !f;
    if (!sel) { closeViewer(); return; }
    if (!f) { closeViewer(); head.append(h('p', { class: 'error' }, `Pane ${sel.pane_id} in session ${sel.session} is no longer in the inventory.`)); return; }
    const { s, p } = f;
    const blocked = p.agent_status === 'blocked';
    const input = (name, label, kind = 'input', ph = '') => h('div', {}, h('label', { for: 'f-' + name }, label),
      kind === 'textarea' ? h('textarea', { id: 'f-' + name, 'data-keep': name, placeholder: ph }, keep[name] || '') : h('input', { id: 'f-' + name, 'data-keep': name, value: keep[name] || '', placeholder: ph, autocomplete: 'off', spellcheck: 'false' }));
    const val = (n) => ($('f-' + n) ? $('f-' + n).value : '');

    head.append(h('h2', {}, `${s.session} / ${p.pane_id}`, ' ', chip(p.agent ? p.agent_status : null)),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Agent'), h('dd', {}, p.agent ? `${p.agent_name || p.agent} (${p.agent})` : 'none — plain terminal'),
        h('dt', {}, 'Terminal'), h('dd', {}, p.terminal_id),
        h('dt', {}, 'Working dir'), h('dd', {}, p.foreground_cwd || p.cwd || 'unknown'),
        h('dt', {}, 'Snapshot'), h('dd', {}, `${ago(s.snapshot_age_ms)}${s.stale ? ' (stale)' : ''}`)));
    syncViewer(f);

    if (blocked) {
      ctl.append(h('div', { class: 'blocked-box', role: 'alert' },
        h('strong', {}, 'Blocked: waiting for a decision. '),
        'This agent is showing an approval or question dialog. The portal sends nothing to it and has no way to answer for you. Decide in Herdr; the status updates here within seconds.'));
      return;
    }

    if (p.agent) {
      const g = h('div', { class: 'group' }, h('h2', {}, 'Prompt the agent'),
        input('prompt', 'Prompt', 'textarea', 'What should the agent do?'),
        h('div', { class: 'row' }, h('label', { for: 'f-wait', class: 'inline' }, 'Wait for it to settle'),
          h('select', { id: 'f-wait' }, h('option', { value: '0' }, 'no wait'), h('option', { value: '30000' }, 'up to 30s'), h('option', { value: '55000' }, 'up to 55s')),
          h('button', { type: 'button', class: 'primary', onclick: () => { const t = val('prompt'); if (t.trim()) { const w = Number(val('wait') || 0); write('herdr.agent_prompt', 'prompt', { text: t, ...(w ? { wait_timeout_ms: w } : {}) }, t + '|' + w); } } }, 'Send prompt')),
        h('p', { class: 'muted' }, 'A result means the input was delivered, not that the task finished.'));
      ctl.append(g);
      ctl.append(h('div', { class: 'group' }, h('h2', {}, 'Agent keys'), input('akeys', 'Keys, space separated (e.g. esc, ctrl+c)'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const k = val('akeys').trim().split(/\s+/).filter(Boolean); if (k.length) write('herdr.agent_send_keys', 'akeys', { keys: k }, k.join(' ')); } }, 'Send keys'),
          h('button', { type: 'button', onclick: () => waitAgent() }, 'Wait for idle/done/blocked (30s)'))));
    } else {
      ctl.append(h('div', { class: 'group' }, h('h2', {}, 'Run a command in this terminal'), input('cmd', 'Command line (typed and submitted with Enter)', 'input', 'printf hello'),
        h('div', { class: 'row' }, confirmButton('Run', 'Confirm: run in this pane', () => { const t = val('cmd'); return t.trim() ? write('herdr.pane_run', 'cmd', { text: t }, t) : Promise.resolve(); }),
          h('span', { class: 'muted' }, 'The text is sent to the pane; the portal never runs it.'))));
      ctl.append(h('div', { class: 'group' }, h('h2', {}, 'Send text or keys (no Enter)'), input('txt', 'Text'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const t = val('txt'); if (t) write('herdr.pane_send_text', 'txt', { text: t }, t); } }, 'Send text')),
        input('pkeys', 'Keys, space separated (e.g. enter, ctrl+c)'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { const k = val('pkeys').trim().split(/\s+/).filter(Boolean); if (k.length) write('herdr.pane_send_keys', 'pkeys', { keys: k }, k.join(' ')); } }, 'Send keys'))));
      ctl.append(h('div', { class: 'group' }, h('h2', {}, 'Start an agent here'),
        input('aname', 'Agent name (lowercase letters, digits, - _)'),
        h('div', { class: 'row' }, h('select', { id: 'f-akind', 'aria-label': 'Agent kind' }, ['claude', 'codex', 'pi', 'droid', 'opencode', 'gemini'].map((k) => h('option', { value: k }, k))),
          confirmButton('Start agent', 'Confirm: start agent', () => { const n = val('aname'); return n ? write('herdr.agent_start', 'astart', { name: n, kind: val('akind') }, n + val('akind')) : Promise.resolve(); }))));
    }
  }

  // ---------- viewer ----------
  // One viewer per selected pane and terminal. Its elements (and the text node inside the output box) are created once and
  // updated in place, so the 5 s inventory render never touches them and the reader keeps their place.
  const SOURCE = { screen: 'visible', history: 'recent_unwrapped', detection: 'detection' };
  const MODES = [['screen', 'Screen'], ['history', 'History'], ['detection', 'Detection']];
  const caps = () => (health && health.capabilities) || {};
  const controlOn = () => caps().control === true;
  const historyOn = (p) => caps().history === 'all' || (caps().history === 'agents' && !!p.agent);
  const viewKey = (f) => `${f.s.session}|${f.p.pane_id}|${f.p.terminal_id}`;
  const enc = encodeURIComponent;

  function syncViewer(f) {
    if (!view || view.key !== viewKey(f)) openViewer(f); else updateToolbar(view);
  }

  function closeViewer() {
    if (!view) return;
    clearTimeout(view.timer); if (view.ctl) view.ctl.abort();
    view = null; const slot = $('viewer'); if (slot) slot.replaceChildren();
  }

  function openViewer(f) {
    closeViewer();
    const v = view = { key: viewKey(f), session: f.s.session, pane_id: f.p.pane_id, terminal_id: f.p.terminal_id, mode: 'screen', lines: 500, text: '', first: true, failures: 0, loading: false,
      timer: null, ctl: null, hostScroll: false, scrollAsked: false, scrollBusy: false, clickBusy: false, statusText: null, msg: null, click: { on: false, cell: null } };
    const btn = (label, onclick, props = {}) => h('button', { type: 'button', onclick, ...props }, label);
    const el = v.el = {};
    el.modes = MODES.map(([m, label]) => btn(label, () => setMode(v, m), { 'aria-pressed': 'false' }));
    el.more = btn('Load more', () => { v.lines = V.nextLines(v.lines); loadView(); });
    el.again = btn('Read again', () => loadView());
    el.updated = h('span', { class: 'muted' });
    el.up = btn('Scroll pane up', () => scrollPane(v, 'up'));
    el.down = btn('Scroll pane down', () => scrollPane(v, 'down'));
    el.bottom = btn('Pane to bottom', () => scrollPane(v, 'bottom'));
    el.clickToggle = btn('Click mode', () => toggleClick(v), { 'aria-pressed': 'false' });
    el.status = h('p', { class: 'viewer-status', role: 'status' });
    v.textNode = document.createTextNode('');
    el.pre = h('pre', { class: 'term', tabindex: '0', 'aria-label': 'Pane output' }, v.textNode);
    el.probe = h('span', { class: 'probe term', 'aria-hidden': 'true' }, 'M'.repeat(20));
    el.jump = btn('Jump to latest', () => { el.pre.scrollTop = el.pre.scrollHeight; updateJump(v); }, { class: 'jump', hidden: true });
    el.col = h('input', { id: 'click-col', type: 'number', min: '0', inputmode: 'numeric', autocomplete: 'off' });
    el.row = h('input', { id: 'click-row', type: 'number', min: '0', inputmode: 'numeric', autocomplete: 'off' });
    el.text = h('input', { id: 'click-text', type: 'text', maxlength: '120', autocomplete: 'off', spellcheck: 'false' });
    el.go = btn('Click here', () => sendClick(v), { class: 'primary', disabled: true });
    el.hint = h('span', { class: 'muted hint' });
    el.panel = h('div', { class: 'click-panel group', hidden: true },
      h('p', { class: 'muted' }, 'Tap a cell on the screen, or enter its column, row and the text you see there (cells count from 0). The click is sent only if that text is still under the cell.'),
      h('div', { class: 'row' }, h('div', {}, h('label', { for: 'click-col' }, 'Column'), el.col), h('div', {}, h('label', { for: 'click-row' }, 'Row'), el.row),
        h('div', { class: 'grow' }, h('label', { for: 'click-text' }, 'Text under the cell'), el.text)),
      h('div', { class: 'row' }, el.go, btn('Cancel', () => clearCell(v)), el.hint));
    for (const i of [el.col, el.row, el.text]) i.addEventListener('input', () => fieldsChanged(v));
    el.pre.addEventListener('scroll', () => updateJump(v));
    el.pre.addEventListener('click', (ev) => tap(v, ev));
    $('viewer').replaceChildren(
      h('div', { class: 'toolbar row', role: 'group', 'aria-label': 'View' }, ...el.modes, el.more, el.again, el.updated),
      h('div', { class: 'toolbar row', role: 'group', 'aria-label': 'Pane controls' }, el.up, el.down, el.bottom, el.clickToggle),
      el.status, h('div', { class: 'term-wrap' }, el.pre, el.probe, el.jump), el.panel);
    refreshStatus(v); updateToolbar(v); loadView(); refreshScrollInfo(v);
  }

  function setStatus(v, text, bad = false) {
    if (v.statusText !== text) { v.statusText = text; v.el.status.textContent = text; }
    v.el.status.className = 'viewer-status' + (bad ? ' error' : '');
  }

  // The status line changes only when the state does ("updated" is a separate element), so a screen reader is not read to every 1.5 s.
  function refreshStatus(v) {
    const label = MODES.find(([m]) => m === v.mode)[1];
    if (v.msg && Date.now() - v.msgAt > 10000) v.msg = null;
    if (v.error) return setStatus(v, `${label} · ${v.error}${v.mode === 'screen' ? ' · retrying' : ''}`, true);
    if (v.msg) return setStatus(v, v.msg, v.msgBad);
    if (v.note) return setStatus(v, v.note);
    if (v.loading && (v.mode !== 'screen' || v.first)) return setStatus(v, `${label} · reading…`);
    if (v.mode === 'screen') return setStatus(v, v.click.cell ? 'Screen · updates paused while a click is pending' : 'Screen · live, updating every 1.5 s');
    if (v.mode === 'history') return setStatus(v, `History · ${v.returned == null ? 0 : v.returned} lines${v.truncated ? ' (cut at 262,144 characters)' : ''}`);
    return setStatus(v, 'Detection · read once');
  }

  function say(v, text, bad) { v.msg = text; v.msgBad = !!bad; v.msgAt = Date.now(); refreshStatus(v); }

  function updateToolbar(v) {
    const f = findPane(); if (!f || viewKey(f) !== v.key) return;
    const p = f.p; const el = v.el; const screen = v.mode === 'screen';
    if (v.mode === 'history' && !historyOn(p)) { setMode(v, 'screen'); return; }
    MODES.forEach(([m], i) => el.modes[i].setAttribute('aria-pressed', v.mode === m ? 'true' : 'false'));
    el.modes[1].hidden = !historyOn(p);
    el.more.hidden = v.mode !== 'history'; el.more.disabled = v.loading || !V.canLoadMore(v.lines);
    el.again.hidden = screen; el.again.disabled = v.loading;
    const canScroll = controlOn() && !p.agent && screen;
    el.up.hidden = !canScroll; el.down.hidden = !canScroll; el.bottom.hidden = !(canScroll && v.hostScroll);
    el.up.disabled = v.scrollBusy; el.down.disabled = v.scrollBusy; el.bottom.disabled = v.scrollBusy;
    const canClick = controlOn() && screen && (!p.agent || (caps().agent_click === true && (p.agent_status === 'idle' || p.agent_status === 'done')));
    if (!canClick && v.click.on) { v.click.on = false; clearCell(v); }
    el.clickToggle.hidden = !canClick; el.clickToggle.setAttribute('aria-pressed', v.click.on ? 'true' : 'false');
    el.panel.hidden = !v.click.on;
  }

  function setMode(v, mode) {
    if (v !== view) return;
    if (v.mode !== mode) {
      v.mode = mode; v.first = true; v.error = null; v.note = null; v.msg = null; v.returned = null; v.lines = 500; v.failures = 0;
      v.click.on = false; clearCell(v);
      v.textNode.nodeValue = '';
    }
    updateToolbar(v); loadView();
  }

  async function loadView() {
    const v = view; if (!v || !token) return;
    clearTimeout(v.timer); if (v.ctl) v.ctl.abort();
    const ctl = v.ctl = new AbortController();
    const f = findPane(); if (!f || viewKey(f) !== v.key) return;
    v.loading = true; refreshStatus(v); updateToolbar(v);
    const want = { gen: ++readGen, session: v.session, pane_id: v.pane_id, terminal_id: v.terminal_id };
    const path = `/api/herdr/pane_read?session=${enc(v.session)}&pane_id=${enc(v.pane_id)}&source=${SOURCE[v.mode]}&expect_terminal_id=${enc(v.terminal_id)}${v.mode === 'history' ? '&lines=' + v.lines : ''}`;
    let r;
    try { r = await api(path, { signal: ctl.signal }); }
    catch (e) {
      if (view !== v || ctl.signal.aborted || !token) return;
      v.loading = false; v.failures += 1; v.error = 'portal unreachable';
      refreshStatus(v); updateToolbar(v); scheduleNext(v); return;
    }
    if (view !== v || ctl.signal.aborted) return;
    v.loading = false;
    const verdict = readVerdict(want, { gen: readGen, sel }, r.json);
    if (verdict === 'drop') { updateToolbar(v); return; }
    const err = r.json && r.json.error;
    if (verdict === 'show') {
      v.failures = 0; v.error = null; v.note = null; v.returned = r.json.lines_returned; v.truncated = r.json.truncated === true;
      v.text = r.json.result.read.text || ''; applyText(v); v.el.updated.textContent = 'Updated ' + new Date().toTimeString().slice(0, 8);
    } else if (verdict === 'error' && err && err.code === 'history_unavailable') { // a short pane is a normal answer, not a failure
      v.failures = 0; v.error = null; v.note = 'No history beyond the screen for this pane'; v.text = err.visible_text || ''; applyText(v);
    } else {
      v.failures += 1;
      v.error = verdict === 'mismatch' ? 'the answer does not match the selected session, pane and terminal; read again' : err ? `${err.code}: ${err.message}` : `HTTP ${r.status}`;
    }
    refreshStatus(v); updateToolbar(v); scheduleNext(v);
  }

  // Screen mode polls on a timer chain, so there is never more than one request in flight; it backs off after failures,
  // idles while the tab is hidden, and waits while a click is pending so the cell cannot move under the reader.
  function scheduleNext(v) {
    clearTimeout(v.timer);
    if (v !== view || v.mode !== 'screen') return;
    v.timer = setTimeout(() => {
      if (v !== view) return;
      if (document.hidden || v.click.cell) { scheduleNext(v); return; }
      loadView();
    }, V.nextPollDelay(v.failures));
  }

  function applyText(v) {
    const pre = v.el.pre; const wasAtBottom = V.atBottom(pre); const fromBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    v.textNode.nodeValue = v.text === '' ? '(empty)' : v.text;
    pre.scrollTop = v.first || wasAtBottom ? pre.scrollHeight : V.keepPlace(pre.scrollHeight, pre.clientHeight, fromBottom);
    v.first = false; paintMark(v); updateJump(v);
  }

  const updateJump = (v) => { v.el.jump.hidden = V.atBottom(v.el.pre); };

  function metrics(v) {
    const pre = v.el.pre; const r = pre.getBoundingClientRect(); const cs = getComputedStyle(pre); const probe = v.el.probe.getBoundingClientRect();
    return { left: r.left, top: r.top, padLeft: parseFloat(cs.paddingLeft) || 0, padTop: parseFloat(cs.paddingTop) || 0, scrollLeft: pre.scrollLeft, scrollTop: pre.scrollTop, cw: probe.width / 20, lh: parseFloat(cs.lineHeight) || probe.height };
  }

  // The selected cell is shown by splitting the text around it into <mark> and <span> pieces (no style is written from script);
  // with no cell the one text node goes back in. The text stays the same, so selecting and copying it still work.
  function paintMark(v) {
    const pre = v.el.pre; const cell = v.click.on && v.click.cell; const lines = v.text.split('\n');
    const row = cell && lines[cell.row] !== undefined ? Array.from(lines[cell.row]) : null;
    const keepTop = pre.scrollTop;
    if (!row || cell.column >= row.length) {
      if (pre.childNodes.length !== 1 || pre.firstChild !== v.textNode) pre.replaceChildren(v.textNode);
    } else {
      const run = V.runAt(lines[cell.row], cell.column) || { start: cell.column, end: cell.column + 1 };
      const at = cell.column; const join = (a, b) => row.slice(a, b).join('');
      pre.replaceChildren(
        lines.slice(0, cell.row).concat(join(0, run.start)).join('\n'),
        h('span', { class: 'run' }, join(run.start, at)), h('mark', { class: 'cell' }, row[at]), h('span', { class: 'run' }, join(at + 1, run.end)),
        [join(run.end, row.length)].concat(lines.slice(cell.row + 1)).join('\n'));
    }
    pre.scrollTop = keepTop;
  }

  // ---------- click mode ----------
  function toggleClick(v) { v.click.on = !v.click.on; v.msg = null; clearCell(v); updateToolbar(v); }

  function clearCell(v) {
    const el = v.el; v.click.cell = null; el.col.value = ''; el.row.value = ''; el.text.value = ''; el.go.disabled = true; el.hint.textContent = '';
    paintMark(v); refreshStatus(v);
  }

  function tap(v, ev) {
    if (!v.click.on) return;
    const lines = v.text.split('\n'); const cell = V.cellAt(ev.clientX, ev.clientY, metrics(v), lines.length);
    if (!cell) return;
    const run = V.runAt(lines[cell.row], cell.column);
    v.msg = null; v.el.col.value = String(cell.column); v.el.row.value = String(cell.row); v.el.text.value = run ? run.text : '';
    if (v.ctl) v.ctl.abort(); v.loading = false; // an answer arriving now would move the text under the cell
    fieldsChanged(v); scheduleNext(v);
  }

  // The three fields are the whole click request; a tap only fills them in. A cell exists while column and row are both numbers.
  function fieldsChanged(v) {
    const el = v.el; const num = (s) => (/^\d{1,4}$/.test(s.trim()) ? Number(s) : null);
    const column = num(el.col.value); const row = num(el.row.value);
    v.click.cell = column !== null && row !== null ? { column, row } : null;
    const short = V.tooShort({ text: el.text.value });
    el.go.disabled = !v.click.cell || short || v.clickBusy;
    el.hint.textContent = v.click.cell && short ? 'too short to click safely' : '';
    paintMark(v); refreshStatus(v);
  }

  const outcome = (b) => {
    if (!b) return ['Nothing was sent.', true];
    if (b.status === 'input_sent') return [`Clicked (${b.detail.column}, ${b.detail.row}) with the ${b.detail.button} button. Whether the app reacts is up to the app.`, false];
    if (b.status === 'needs_review') return ['Outcome uncertain. Inspect the pane before trying again.', true];
    const e = b.error || (b.detail && { code: b.detail.error, message: b.detail.message });
    return [`Not sent: ${e ? `${e.code}: ${e.message}` : 'refused'}${b.error && b.error.row_text !== undefined ? ` The row now reads: ${b.error.row_text}` : ''}`, true];
  };

  async function sendClick(v) {
    const el = v.el; const column = Number(el.col.value); const row = Number(el.row.value); const text = el.text.value;
    v.clickBusy = true; el.go.disabled = true;
    let res;
    try { res = await write('herdr.pane_click', 'click', { column, row, button: 'left', expect_text: text }, `${column},${row},${text}`); }
    finally { v.clickBusy = false; }
    if (view !== v) return;
    const [msg, bad] = outcome(res && res.body);
    clearCell(v); say(v, msg, bad);
  }

  // ---------- scroll buttons ----------
  async function scrollPane(v, direction) {
    v.scrollBusy = true; v.msg = null; updateToolbar(v);
    let res;
    try { res = await write('herdr.pane_scroll', 'scroll-' + direction, { direction }, direction); }
    finally { v.scrollBusy = false; }
    if (view !== v) return;
    const b = res && res.body; const d = (b && b.detail) || {};
    if (b && b.status === 'input_sent') say(v, d.delivered_as === 'host_scrollback' ? `Scrolled the pane ${direction === 'bottom' ? 'to the bottom' : direction} (offset ${d.scroll_after.offset_from_bottom} of ${d.scroll_after.max_offset_from_bottom}). It stays scrolled for its owner until it is moved back.` : `Sent ${d.steps} scroll step(s) as wheel events. What they do is up to the app.`, false);
    else say(v, outcome(b)[0], true);
    refreshScrollInfo(v); updateToolbar(v);
  }

  async function refreshScrollInfo(v) {
    const f = findPane(); if (!controlOn() || !f || f.p.agent) return;
    v.scrollAsked = true;
    try {
      const r = await api(`/api/herdr/pane_get?session=${enc(v.session)}&pane_id=${enc(v.pane_id)}`);
      if (view !== v) return;
      const sc = r.json && r.json.result && r.json.result.pane && r.json.result.pane.scroll;
      v.hostScroll = !!(sc && sc.max_offset_from_bottom > 0); updateToolbar(v);
    } catch { /* "Pane to bottom" stays hidden */ }
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
    if (view) { updateToolbar(view); if (!view.scrollAsked) refreshScrollInfo(view); }
  }

  showLogin();
})();
