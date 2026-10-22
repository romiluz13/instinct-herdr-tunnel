'use strict';
// Shared by the integration tests: a real portal process (server.js) in front of the fake Herdr socket and fake CLI.
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const fake = require('./fake-herdr-server');

const ROOT = path.join(__dirname, '..', '..');
const TOKEN = crypto.randomBytes(32).toString('base64url');

function req(port, method, p, { token = TOKEN, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } resolve({ status: res.statusCode, json: j, text: b, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function boot(dir, port, { version, decision, decisionEnv, strict, env: extraEnv } = {}) {
  // The portal gives the CLI a clean env on purpose, so the fake's settings are baked into a wrapper script.
  const wrapper = path.join(dir, 'herdr');
  fs.writeFileSync(wrapper, `#!/bin/sh\nFAKE_HERDR_DIR='${dir}' FAKE_HERDR_VERSION='${version || '0.9.5'}' exec '${process.execPath}' '${path.join(__dirname, 'fake-herdr-cli.js')}' "$@"\n`, { mode: 0o755 });
  for (const tool of ['ps', 'stty']) fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\nFAKE_HERDR_DIR='${dir}' exec '${process.execPath}' '${path.join(__dirname, 'fake-tool.js')}' ${tool} "$@"\n`, { mode: 0o755 });
  const env = { HERDR_PORTAL_PS_BIN: path.join(dir, 'ps'), HERDR_PORTAL_STTY_BIN: path.join(dir, 'stty'), HERDR_PORTAL_SIZE_TOOL_TIMEOUT_MS: '20000', PATH: process.env.PATH, HOME: dir, HERDR_PORTAL_STATE_DIR: path.join(dir, 'state'), HERDR_PORTAL_LOG_DIR: path.join(dir, 'logs'), HERDR_PORTAL_PORT: String(port), HERDR_BIN: wrapper };
  if (decision) env.HERDR_PORTAL_ENABLE_AGENT_DECISION = '1'; // agent_decision is off unless the operator opts in
  if (decisionEnv !== undefined) env.HERDR_PORTAL_ENABLE_AGENT_DECISION = decisionEnv;
  if (strict) env.HERDR_PORTAL_STRICT_VERSION = '1';
  Object.assign(env, extraEnv);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (out.includes('"listening"')) { await new Promise((r) => setTimeout(r, 400)); return { child, out: () => out }; }
    if (child.exitCode !== null) throw new Error('server exited: ' + out);
  }
  child.kill('SIGKILL'); // a portal that is only slow to start would otherwise outlive the failed test and keep the runner alive
  throw new Error('server did not start: ' + out);
}
const stop = (p) => new Promise((r) => { if (p.child.exitCode !== null) return r(); p.child.once('exit', r); p.child.kill('SIGTERM'); });

async function setup(t, opts) {
  const dir = fs.mkdtempSync('/tmp/hp-');
  fs.mkdirSync(path.join(dir, 'state', 'secrets'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'state', 'secrets', 'portal-token'), TOKEN + '\n', { mode: 0o600 });
  const herdr = await fake.start(path.join(dir, 'herdr.sock'));
  let port; let proc;
  for (let attempt = 0; !proc; attempt++) { // test files run in parallel and each picks a random port: two can pick the same one
    port = 20000 + Math.floor(Math.random() * 20000);
    try { proc = await boot(dir, port, opts); } catch (e) {
      if (attempt < 3 && /EADDRINUSE/.test(e.message)) continue;
      await herdr.close(); fs.rmSync(dir, { recursive: true, force: true }); throw e;
    }
  }
  const ctx = { dir, herdr, port, get proc() { return proc; }, restart: async () => { await stop(proc); proc = await boot(dir, port, opts); } };
  t.after(async () => { await stop(proc).catch(() => {}); await herdr.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return ctx;
}


module.exports = { ROOT, TOKEN, req, boot, stop, setup };
