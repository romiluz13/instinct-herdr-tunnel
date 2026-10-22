'use strict';
// One short-lived Herdr terminal controller per portal action: `herdr terminal session control` (CLI reference, "Direct
// terminal attach"). Commands go in on stdin as NDJSON, records come back on stdout. The process is started with an
// argument array and the portal's clean environment, never with --takeover (the owner's controller is never evicted)
// and never sent terminal.resize (a controller forces the pane to its own size, as observed on Herdr 0.9.5).
//
// Node child_process, v22/24/26: 'close' comes after the process ended AND its stdio closed, 'error' can fire without
// 'exit' (so every path settles once), stdin may be missing and may fail with EPIPE, kill() sends SIGTERM by default.
const { spawn } = require('child_process');
const herdr = require('./herdr');
const { config } = require('./config');
const { ApiError } = require('./validate');

const MAX_CONTROLLERS = 4;
// Free prose from Herdr, seen live on 0.9.5: "terminal attach failed: terminal <id> already has an attached client; retry with --takeover".
// Only a close that says the attach failed is a definite "nothing delivered"; any other close without a frame may follow consumed commands.
const ATTACH_FAILED = /^(?:terminal )?attach failed\b/i;
const BUSY = /attached client|already has/i;
const MAX_LINE = 512 * 1024;
let active = 0;

// Outcome from the order of the records, not from their wording:
//   not_started  nothing was spawned
//   busy|refused terminal.closed arrived before any frame and says the attach failed: nothing was delivered
//   sent         terminal.closed "detached", then exit 0. Frames are optional: Herdr sends one only when the screen changes, and an app
//                that ignores a wheel event leaves it unchanged (seen live, Herdr 0.9.5: three wheel reports delivered, no frame)
//   uncertain    anything else once the commands were written: inspect the pane
function classify(s) {
  if (s.spawnFailed) return { outcome: 'not_started', reason: s.spawnError };
  if (s.killed) return { outcome: 'uncertain', reason: 'the controller was stopped at its deadline' };
  if (s.malformed) return { outcome: 'uncertain', reason: 'the controller printed output that is not JSON lines' };
  const c = s.closed;
  if (c && c.framesBefore === 0 && ATTACH_FAILED.test(c.reason)) return { outcome: BUSY.test(c.reason) ? 'busy' : 'refused', reason: c.reason };
  if (c && c.reason === 'detached' && s.code === 0 && !s.signal) return { outcome: 'sent', reason: null };
  return { outcome: 'uncertain', reason: c ? `closed: ${c.reason}; exit ${s.code}${s.signal ? ' ' + s.signal : ''}` : `no terminal.closed record; exit ${s.code}${s.signal ? ' ' + s.signal : ''}` };
}

function control({ session, terminalId, cols, rows, commands }) {
  if (active >= MAX_CONTROLLERS) return Promise.reject(new ApiError(429, 'too_many_controllers', 'too many terminal controllers are running; nothing was sent'));
  active += 1;
  const started = Date.now();
  const args = ['--session', session, 'terminal', 'session', 'control', terminalId, '--cols', String(cols), '--rows', String(rows)];
  return new Promise((resolve) => {
    const s = { frames: 0, records: [], closed: null, malformed: false, killed: false, spawnFailed: false, spawnError: null, code: null, signal: null };
    let settled = false; let buf = ''; let term = null; let kill = null; let hard = null;
    let child;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(term); clearTimeout(kill); clearTimeout(hard);
      try { if (child && child.stdin) child.stdin.destroy(); } catch { /* already closed */ }
      const { outcome, reason } = classify(s);
      resolve({ outcome, reason, frames: s.frames, records: s.records, exit_code: s.code, signal: s.signal, killed: s.killed, elapsed_ms: Date.now() - started });
    };
    try { child = spawn(config.herdrBin, args, { env: herdr.cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { s.spawnFailed = true; s.spawnError = String(e.code || e.message).slice(0, 100); return finish(); }

    child.on('error', (e) => {
      if (child.pid === undefined) { s.spawnFailed = true; s.spawnError = String(e.code || e.message).slice(0, 100); finish(); }
    });
    child.stderr.on('data', () => {}); // drained, never kept: it can hold terminal text
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { s.malformed = true; continue; }
        if (!rec || typeof rec.type !== 'string') { s.malformed = true; continue; }
        if (rec.type === 'terminal.frame') s.frames += 1;
        else {
          if (rec.type === 'terminal.closed' && !s.closed) s.closed = { reason: String(rec.reason || '').slice(0, 200), framesBefore: s.frames };
          if (s.records.length < 10) s.records.push({ type: rec.type.slice(0, 40), ...(rec.reason ? { reason: String(rec.reason).slice(0, 200) } : {}) });
        }
      }
      if (buf.length > MAX_LINE) { s.malformed = true; buf = ''; }
    });
    child.on('close', (code, signal) => { s.code = code; s.signal = signal; finish(); });

    if (child.stdin) {
      child.stdin.on('error', () => {}); // EPIPE when the process already exited: the classification reads what it printed
      child.stdin.write(commands.map((c) => JSON.stringify(c)).join('\n') + '\n');
    }
    term = setTimeout(() => {
      s.killed = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, config.controllerKillGraceMs);
      hard = setTimeout(finish, config.controllerKillGraceMs + 1500); // 'close' never came (a grandchild holds the pipes): stop waiting, the result is uncertain anyway
    }, config.controllerLifetimeMs);
  }).finally(() => { active -= 1; });
}

module.exports = { control };
