#!/usr/bin/env node
'use strict';
// Runs cloudflared and records the public URL for local status output. Quick Tunnel by default
// (hostname changes every start, no uptime guarantee, no SSE). Named tunnel only when
// <state>/tunnel.json exists: {"mode":"named","name":"...","hostname":"...","config":"/abs/config.yml"}.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config, ensureDirs } = require('../lib/config');

ensureDirs();
const cloudflared = process.env.CLOUDFLARED_BIN || 'cloudflared';
const origin = `http://${config.host}:${config.port}`;
const cfgFile = path.join(config.stateDir, 'tunnel.json');
let named = null;
try { named = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* quick tunnel */ }

const common = ['--no-autoupdate', '--metrics', config.metricsAddr];
const args = named && named.mode === 'named'
  ? ['tunnel', ...common, '--config', named.config, 'run', named.name]
  : ['tunnel', ...common, '--url', origin];
const say = (m) => process.stdout.write(`${new Date().toISOString()} ${m}\n`);

fs.rmSync(config.tunnelUrlFile, { force: true }); // never advertise a URL from a previous run
if (named && named.mode === 'named') { fs.writeFileSync(config.tunnelUrlFile, `https://${named.hostname}\n`); say(`TUNNEL_URL=https://${named.hostname} (named tunnel, persistent hostname)`); }

const child = spawn(cloudflared, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const onData = (d) => {
  const text = String(d);
  process.stdout.write(text);
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  if (m && !(named && named.mode === 'named')) { fs.writeFileSync(config.tunnelUrlFile, m[0] + '\n'); say(`TUNNEL_URL=${m[0]} (Quick Tunnel: changes on every restart)`); }
};
child.stdout.on('data', onData); child.stderr.on('data', onData);
child.on('exit', (code, sig) => { fs.rmSync(config.tunnelUrlFile, { force: true }); say(`cloudflared exited code=${code} signal=${sig}`); process.exit(code === 0 ? 0 : 1); });
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill('SIGTERM'));
