'use strict';
const http = require('http');
const fs = require('fs');
const { config, ensureDirs, PINNED_HERDR_VERSION, PINNED_PROTOCOL } = require('./lib/config');
const { loadTokenDigest } = require('./lib/security');
const { Ledger } = require('./lib/ledger');
const { Audit } = require('./lib/audit');
const { Inventory } = require('./lib/inventory');
const herdr = require('./lib/herdr');
const { createServer } = require('./lib/server');

// Structured logs: event name + non-secret fields only.
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');

function tunnelProbe() {
  return new Promise((resolve) => {
    let url = null;
    try { url = fs.readFileSync(config.tunnelUrlFile, 'utf8').trim() || null; } catch { /* no tunnel yet */ }
    const [host, port] = config.metricsAddr.split(':');
    const req = http.get({ host, port: Number(port), path: '/ready', timeout: 1500 }, (r) => { r.resume(); resolve({ up: r.statusCode === 200, url, probe: `metrics /ready -> ${r.statusCode}` }); });
    req.on('timeout', () => { req.destroy(); resolve({ up: false, url, probe: 'metrics timeout' }); });
    req.on('error', () => resolve({ up: false, url, probe: 'metrics unreachable' }));
  });
}

(async () => {
  ensureDirs();
  const tokenDigest = loadTokenDigest();
  const ledger = new Ledger(config.ledgerFile);
  const audit = new Audit(config.auditFile);
  for (const r of ledger.recovered) { // a crash between "maybe sent" and "result recorded" must still show up in the audit log
    try { audit.append({ timestamp: new Date().toISOString(), action: r.action, session: r.session || null, pane: (r.target && r.target.pane_id) || null, option: null, result: 'needs_review', http_status: null, error_code: 'portal_restarted_before_result_recorded', category: null, replayed: false, request_id: r.request_id, idempotency_key: r.idempotency_key, recovered: true }); } catch { /* reported by audit.healthy */ }
  }
  if (ledger.recovered.length) log('ledger_recovered_needs_review', { count: ledger.recovered.length, keys: ledger.recovered.map((r) => r.idempotency_key) });

  const ctx = {
    ledger, audit, inventory: new Inventory(log), locks: new Map(), waits: 0, herdrVersion: null, cliError: null,
    // Process-wide switch: the CLI version is read ONCE at boot, so upgrading `herdr` needs a portal restart to be seen.
    // Each write additionally pings its own target session after taking the pane lock (lib/actions.js,
    // assertTargetCompatible) and refuses a version or protocol other than the proven one, so one odd session does not
    // switch writes off for the others.
    get writesDisabledReason() {
      if (this.cliError) return `cannot run herdr: ${this.cliError}`;
      if (this.herdrVersion !== PINNED_HERDR_VERSION) return `installed Herdr ${this.herdrVersion} != proven ${PINNED_HERDR_VERSION}; regenerate docs/proof-matrix.md`;
      return null;
    },
    get writesEnabled() { return this.writesDisabledReason === null; },
  };
  try { ctx.herdrVersion = await herdr.installedVersion(); } catch (e) { ctx.cliError = e.code; }
  log('boot', { version: config.version, herdr: ctx.herdrVersion, pinned: PINNED_HERDR_VERSION, protocol_pinned: PINNED_PROTOCOL, writes_enabled: ctx.writesEnabled });

  await ctx.inventory.start();
  const server = createServer({ ctx, tokenDigest, log, tunnelProbe });
  server.listen(config.port, config.host, () => log('listening', { host: config.host, port: config.port }));
  const stop = (sig) => { log('shutdown', { sig }); ctx.inventory.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
})().catch((e) => { log('fatal', { message: String(e.message) }); process.exit(1); });
