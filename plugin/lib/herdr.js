'use strict';
// A small client for Herdr's Unix socket (newline-delimited JSON). It can call three methods and nothing else: this plugin shows
// and arranges, and has no way to type into a pane, start an agent or stop anything.
const net = require('node:net');

const ALLOWED = new Set(['agent.view.set', 'agent.view.clear', 'plugin.pane.open']);

function call(sockPath, method, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED.has(method)) return reject(Object.assign(new Error(`${method} is not a method this plugin calls`), { code: 'method_not_allowed' }));
    const s = net.connect(sockPath);
    let buf = ''; let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); s.destroy(); fn(v); };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(`${method} timed out`), { code: 'timeout' })), timeoutMs);
    s.setEncoding('utf8');
    s.on('connect', () => s.write(JSON.stringify({ id: 'plugin:' + method, method, params }) + '\n'));
    s.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      try {
        const m = JSON.parse(buf.slice(0, i));
        if (m.error) finish(reject, Object.assign(new Error(m.error.message || m.error.code), { code: m.error.code }));
        else finish(resolve, m.result);
      } catch (e) { finish(reject, e); }
    });
    s.on('error', (e) => finish(reject, e));
    s.on('close', () => finish(reject, Object.assign(new Error(`${method}: connection closed`), { code: 'closed' })));
  });
}

module.exports = { call, ALLOWED };
