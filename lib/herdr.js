'use strict';
// Transport to Herdr: raw socket (newline-delimited JSON, one request/connection)
// for methods that exist in the installed schema, and the CLI for the two
// documented CLI-only operations (`session list`, `pane run`).
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const { config } = require('./config');

class HerdrError extends Error {
  constructor(code, message, { definite = false } = {}) {
    super(message);
    this.code = code;
    // definite=true: Herdr answered with a structured error, i.e. the request was processed and refused.
    this.definite = definite;
  }
}

function validSocketPath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && path.basename(p) === 'herdr.sock';
}

function call(socketPath, method, params, { timeoutMs = config.socketTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    if (!validSocketPath(socketPath)) return reject(new HerdrError('bad_socket', 'invalid socket path'));
    const id = 'portal_' + Math.random().toString(36).slice(2, 10);
    const sock = net.connect(socketPath);
    let buf = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new HerdrError('socket_timeout', `timeout after ${timeoutMs}ms`)), timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { return done(reject, new HerdrError('bad_response', 'unparseable response')); }
        if (msg.id !== id) continue;
        if (msg.error) return done(reject, new HerdrError(msg.error.code || 'herdr_error', msg.error.message || 'error', { definite: true }));
        return done(resolve, msg.result);
      }
    });
    // ENOENT/ECONNREFUSED happen at connect time: nothing was written, so the request definitely did not run.
    sock.on('error', (e) => done(reject, new HerdrError('socket_error', e.code || e.message, { definite: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' })));
    sock.on('close', () => done(reject, new HerdrError('socket_closed', 'connection closed before response')));
  });
}

function cleanEnv() {
  // Never inherit HERDR_* from a pane the portal might have been started from.
  return { PATH: process.env.PATH || '/usr/bin:/bin:/opt/homebrew/bin', HOME: process.env.HOME || '' };
}

function cli(args, { timeoutMs = config.cliTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    execFile(config.herdrBin, args, { env: cleanEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        let code = 'cli_error';
        let definite = false;
        try { code = JSON.parse(stderr).error.code || code; definite = true; } catch { /* not structured */ }
        if (err.killed) code = 'cli_timeout';
        return reject(new HerdrError(code, (stderr || err.message).slice(0, 300), { definite }));
      }
      resolve(stdout);
    });
  });
}

async function listSessions() {
  const out = await cli(['session', 'list', '--json']);
  const j = JSON.parse(out);
  return (j.sessions || []).map((s) => ({
    name: s.name,
    default: !!s.default,
    running: !!s.running,
    socket_path: s.socket_path,
    session_dir: s.session_dir,
  }));
}

async function installedVersion() {
  const out = await cli(['--version']);
  return out.trim().replace(/^herdr\s+/, '');
}

module.exports = { call, cli, listSessions, installedVersion, HerdrError, validSocketPath };
