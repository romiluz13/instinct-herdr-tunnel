'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// The Herdr build the portal was last proven against live. Not a limit on writes (lib/compat.js judges the installed
// Herdr by its own schema); HERDR_PORTAL_STRICT_VERSION=1 makes it one.
const PINNED_HERDR_VERSION = '0.9.3';

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
  dropDir: process.env.HERDR_PORTAL_DROP_DIR || path.join(appSupport, 'inbox'), // the only place put_file may write
  allowedHostSuffixes: ['.trycloudflare.com'],
  extraAllowedHosts: [...(process.env.HERDR_PORTAL_HOSTS || '').split(','), namedHost || ''].map((s) => s.trim().toLowerCase()).filter(Boolean),
  pollIntervalMs: 3000,
  discoveryIntervalMs: 15000,
  staleAfterMs: 15000,
  maxBodyBytes: 16 * 1024,
  maxPutFileBodyBytes: 2 * 1024 * 1024, // 262144 content bytes can need 6x that as JSON \u escapes (1.5 MiB) plus the other fields; RFC 8259 section 7: control characters U+0000-U+001F "MUST be escaped", written as a six-character \uXXXX sequence
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
  // Created with 0700 when missing; an existing drop root is never chmod'ed (HERDR_PORTAL_DROP_DIR may point at a directory the operator shares).
  if (!fs.existsSync(config.dropDir)) fs.mkdirSync(config.dropDir, { recursive: true, mode: 0o700 });
}

module.exports = { config, ensureDirs, PINNED_HERDR_VERSION };
