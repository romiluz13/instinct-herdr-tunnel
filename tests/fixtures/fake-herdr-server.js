'use strict';
// Fake Herdr socket server (newline-delimited JSON). Records every request in `calls`.
const net = require('net');
const fs = require('fs');
function start(sockPath) {
  const calls = [];
  const state = {
    panes: {
      'w1:p1': { pane_id: 'w1:p1', terminal_id: 'term_aa01', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/test', agent: null, agent_status: 'unknown', focused: false },
      'w1:p2': { pane_id: 'w1:p2', terminal_id: 'term_aa02', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/a', agent: 'claude', agent_status: 'idle', focused: false },
      'w1:p3': { pane_id: 'w1:p3', terminal_id: 'term_aa03', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/b', agent: 'codex', agent_status: 'blocked', focused: false },
    },
    fg: {}, serverVersion: '0.9.5', protocol: 22, errorOn: {},
    hangOn: null, // method name that closes the connection without answering
    delayMs: {}, // method -> milliseconds before the answer is written (a slow or busy Herdr)
    // pane_id -> { header: string[], options: string[], cursor, numbered, afterEnter: 'clear'|'stay', ignoreMoves }
    // pane_id -> PaneScrollInfo (offset_from_bottom, max_offset_from_bottom, viewport_rows); shown by pane.get
    scroll: {},
    pids: {}, tty: {}, // pane_id -> { shell, fg } pids and pane_id -> tty name reported by pane.process_info (the tty field is optional in Herdr)
    // pane_id -> { source: text } canned answers for pane.read; readTruncated: pane_id -> the result's truncated flag
    reads: {}, readTruncated: {},
    dialogs: {}, chosen: {}, calls: 0, onCall: null, // onCall(req, n) runs before each request is handled
    subscribers: [],
  };
  const snapshot = () => ({
    version: state.serverVersion, protocol: state.protocol, focused_pane_id: 'w1:p1', focused_tab_id: 'w1:t1', focused_workspace_id: 'w1',
    workspaces: [{ workspace_id: 'w1', label: 'test', agent_status: 'idle', pane_count: 3, tab_count: 1 }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
    panes: Object.values(state.panes), agents: Object.values(state.panes).filter((p) => p.agent).map((p) => ({ pane_id: p.pane_id, agent: p.agent, agent_status: p.agent_status, name: null })),
  });
  const render = (d) => ['claude', '~/x', '❯ claude', '─'.repeat(65), ...d.header.map((h) => ' ' + h), '',
    ...d.options.map((o, i) => (i === d.cursor ? ' ❯ ' : '   ') + (d.numbered ? `${i + 1}. ` : '') + o), '', ' Enter to confirm · Esc to cancel'];
  const screen = (d) => { const all = render(d); return (d.viewportRows ? all.slice(-d.viewportRows) : all).join('\n'); }; // viewportRows: a small pane shows only the bottom rows
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        calls.push({ method: req.method, params: req.params, at: Date.now() });
        state.calls += 1; if (state.onCall) state.onCall(req, state.calls);
        const out = (line) => (state.delayMs[req.method] ? setTimeout(() => sock.write(line), state.delayMs[req.method]) : sock.write(line));
        const reply = (result) => out(JSON.stringify({ id: req.id, result }) + '\n');
        const err = (code, message) => out(JSON.stringify({ id: req.id, error: { code, message } }) + '\n');
        if (state.hangOn === req.method) { sock.destroy(); continue; }
        if (state.errorOn[req.method]) { err(state.errorOn[req.method], 'forced'); continue; }
        const pane = req.params && state.panes[req.params.pane_id || req.params.target];
        switch (req.method) {
          case 'ping': reply({ type: 'pong', ...(state.serverVersion ? { version: state.serverVersion } : {}), ...(state.protocol != null ? { protocol: state.protocol } : {}) }); break;
          case 'session.snapshot': reply({ type: 'session_snapshot', snapshot: snapshot() }); break;
          case 'events.subscribe': reply({ type: 'subscription_started' }); state.subscribers.push(sock); break;
          case 'pane.get': pane ? reply({ type: 'pane_info', pane: state.scroll[pane.pane_id] ? { ...pane, scroll: state.scroll[pane.pane_id] } : pane }) : err('pane_not_found', 'pane not found'); break;
          // Result shapes per the 0.9.4 schema's ResponseResult (workspace_list/_info, tab_list/_info, pane_list).
          case 'workspace.list': reply({ type: 'workspace_list', workspaces: snapshot().workspaces }); break;
          case 'workspace.get': { const w = snapshot().workspaces.find((x) => x.workspace_id === req.params.workspace_id); w ? reply({ type: 'workspace_info', workspace: w }) : err('workspace_not_found', 'workspace not found'); break; }
          case 'tab.list': reply({ type: 'tab_list', tabs: snapshot().tabs }); break;
          case 'tab.get': { const x = snapshot().tabs.find((y) => y.tab_id === req.params.tab_id); x ? reply({ type: 'tab_info', tab: x }) : err('tab_not_found', 'tab not found'); break; }
          case 'pane.list': reply({ type: 'pane_list', panes: snapshot().panes }); break;
          case 'agent.get': pane && pane.agent ? reply({ type: 'agent_info', agent: pane }) : err('agent_not_found', 'no agent'); break;
          case 'pane.read': if (pane && state.reads[pane.pane_id] && state.reads[pane.pane_id][req.params.source] !== undefined) { reply({ type: 'pane_read', read: { pane_id: pane.pane_id, source: req.params.source, format: 'text', text: state.reads[pane.pane_id][req.params.source], revision: 0, truncated: !!state.readTruncated[pane.pane_id] } }); break; }
            if (pane && state.dialogs[pane.pane_id]) { reply({ type: 'pane_read', read: { pane_id: req.params.pane_id, text: screen(state.dialogs[pane.pane_id]), source: req.params.source } }); break; }
            reply({ type: 'pane_read', read: { pane_id: req.params.pane_id, text: pane && pane.agent_status === 'blocked' ? 'Allow this command? [y/n]' : 'hello from ' + req.params.source, source: req.params.source } }); break;
          case 'pane.process_info': {
            const id = req.params.pane_id; const shell = (state.pids[id] && state.pids[id].shell) || 4100 + Number(String(id).split(':p')[1] || 0); const fg = (state.pids[id] && state.pids[id].fg) || shell;
            reply({ type: 'pane_process_info', process_info: { pane_id: id, shell_pid: shell, foreground_process_group_id: fg, ...(state.tty[id] ? { tty: state.tty[id] } : {}), foreground_processes: [{ pid: fg, argv0: (state.fg[id] || 'zsh'), name: (state.fg[id] || 'zsh') }] } }); break;
          }
          case 'pane.scroll': {
            const m = state.scroll[req.params.pane_id];
            if (state.noScrollMethod) { err('unknown_method', 'pane.scroll'); break; }
            if (!pane || !m) { err('pane_not_found', 'pane not found'); break; }
            // Clamps like Herdr 0.9.5: above max gives max; a pane with max 0 stays put.
            m.offset_from_bottom = Math.max(0, Math.min(req.params.offset_from_bottom, m.max_offset_from_bottom));
            reply({ type: 'pane_info', pane: { ...pane, scroll: { ...m } } }); break;
          }
          case 'agent.list': reply({ type: 'agent_list', agents: snapshot().agents }); break;
          case 'agent.wait': reply({ type: 'agent_info', agent: pane }); break;
          case 'agent.send_keys': {
            const d = pane && state.dialogs[pane.pane_id];
            if (d) for (const k of req.params.keys) {
              if (k === 'up' && !d.ignoreMoves) d.cursor = Math.max(0, d.cursor - 1);
              else if (k === 'down' && !d.ignoreMoves) d.cursor = Math.min(d.options.length - 1, d.cursor + 1);
              else if (k === 'enter') { state.chosen[pane.pane_id] = d.options[d.cursor]; if (d.afterEnter !== 'stay') { delete state.dialogs[pane.pane_id]; pane.agent_status = 'idle'; } }
            }
            reply({ type: 'ok', agent: pane }); break;
          }
          case 'agent.prompt': case 'pane.send_text': case 'pane.send_keys': reply({ type: 'ok', agent: pane }); break;
          case 'agent.start': reply({ type: 'agent_info', agent: pane }); break;
          default: err('unknown_method', req.method);
        }
      }
    });
  });
  fs.rmSync(sockPath, { force: true });
  return new Promise((resolve) => server.listen(sockPath, () => resolve({
    calls, state, close: () => new Promise((r) => { state.subscribers.forEach((s) => s.destroy()); server.close(r); }),
    emit: () => state.subscribers.forEach((s) => s.write(JSON.stringify({ id: 'portal_sub', event: { type: 'pane.updated' } }) + '\n')),
    writes: () => calls.filter((c) => /^(agent\.(prompt|send_keys|start)|pane\.send_(text|keys))$/.test(c.method)),
  })));
}
module.exports = { start };
