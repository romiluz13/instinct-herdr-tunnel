'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Herdr version whose schema the allowlist was proven against. A different
// installed version disables writes until docs/proof-matrix.md is regenerated.
const PINNED_HERDR_VERSION = '0.9.3';
const PINNED_PROTOCOL = 22;

const home = os.homedir();
const appSupport = process.env.HERDR_PORTAL_STATE_DIR || path.join(home, 'Library', 'Application Support', 'herdr-portal');
const logDir = process.env.HERDR_PORTAL_LOG_DIR || path.join(home, 'Library', 'Logs', 'herdr-portal');

let namedHost = null;
try { const t = JSON.parse(fs.readFileSync(path.join(appSupport, 'tunnel.json'), 'utf8')); if (t.mode === 'named' && typeof t.hostname === 'string') namedHost = t.hostname.toLowerCase(); } catch { /* quick tunnel */ }

const config = {
  version: '1.0.0',
  host: '127.0.0.1',
  port: Number(process.env.HERDR_PORTAL_PORT || 8787),
  metricsAddr: process.env.HERDR_PORTAL_TUNNEL_METRICS || '127.0.0.1:20241',
  herdrBin: process.env.HERDR_BIN || 'herdr', // resolved on PATH; under launchd/systemd set HERDR_BIN to an absolute path
  stateDir: appSupport,
  logDir,
  tokenFile: path.join(appSupport, 'secrets', 'portal-token'),
  ledgerFile: path.join(appSupport, 'ledger.jsonl'),
  auditFile: path.join(logDir, 'audit.jsonl'),
  tunnelUrlFile: path.join(appSupport, 'tunnel-url.txt'),
  allowedHostSuffixes: ['.trycloudflare.com'],
  extraAllowedHosts: [...(process.env.HERDR_PORTAL_HOSTS || '').split(','), namedHost || ''].map((s) => s.trim().toLowerCase()).filter(Boolean),
  pollIntervalMs: 3000,
  discoveryIntervalMs: 15000,
  staleAfterMs: 15000,
  maxBodyBytes: 16 * 1024,
  maxWaitMs: 55000,
  maxConcurrentWaits: 8,
  socketTimeoutMs: 8000,
  cliTimeoutMs: 10000,
};

function ensureDirs() {
  for (const [dir, mode] of [[config.stateDir, 0o700], [path.dirname(config.tokenFile), 0o700], [config.logDir, 0o700]]) {
    fs.mkdirSync(dir, { recursive: true, mode });
    fs.chmodSync(dir, mode);
  }
}

module.exports = { config, ensureDirs, PINNED_HERDR_VERSION, PINNED_PROTOCOL };
