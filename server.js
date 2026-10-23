'use strict';
const http = require('http');
const fs = require('fs');
const { config, ensureDirs, PINNED_HERDR_VERSION } = require('./lib/config');
const compat = require('./lib/compat');
const { ACTIONS, reconciledAudit } = require('./lib/actions');
const { loadTokenDigest } = require('./lib/security');
const { Ledger } = require('./lib/ledger');
const { Audit } = require('./lib/audit');
const { Inventory } = require('./lib/inventory');
const herdr = require('./lib/herdr');
const { createServer } = require('./lib/server');
const { HISTORY, CONTROL, AGENT_CLICK, TAG_PANES, capabilities } = require('./lib/gates');

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
  // Owed audit lines (a crash or audit failure between an outcome and its audit line, or a half-done request finalized
  // as needs_review) are written from the ledger rows; nothing is re-sent.
  const reconciled = ledger.reconcile((row) => audit.append(reconciledAudit(row)));
  if (reconciled || ledger.owed.length) log('audit_reconciled', { count: reconciled, still_owed: ledger.owed.length });
  if (ledger.recovered.length) log('ledger_recovered_needs_review', { count: ledger.recovered.length, keys: ledger.recovered.map((r) => r.idempotency_key) });

  const ctx = {
    ledger, audit, inventory: new Inventory(log), locks: new Map(), waits: 0, herdrVersion: null, cliError: null,
    // Process-wide switch: the installed CLI must run and its schema must have been read. Which actions may write is judged
    // per action from that schema (lib/compat.js); each write also pings its own target session after taking the pane lock
    // (lib/actions.js, assertTargetCompatible), so one odd session does not switch writes off for the others.
    compat: null, strict: process.env.HERDR_PORTAL_STRICT_VERSION === '1',
    get writesDisabledReason() {
      if (this.cliError) return `cannot run herdr: ${this.cliError}`;
      if (!this.compat) return 'the installed Herdr CLI schema has not been read';
      if (this.strict && this.herdrVersion !== PINNED_HERDR_VERSION) return `HERDR_PORTAL_STRICT_VERSION=1 and installed Herdr ${this.herdrVersion} != proven ${PINNED_HERDR_VERSION}`;
      return null;
    },
    get writesEnabled() { return this.writesDisabledReason === null; },
  };
  // Re-reads the CLI when it changed (an upgrade needs no portal restart). One read at a time; a failure keeps writes off.
  let reading = null;
  ctx.refreshCompat = (force = false) => (reading = reading || (async () => {
    try {
      const v = await herdr.installedVersion();
      if (!force && ctx.compat && ctx.compat.version === v) return;
      const c = await compat.evaluate(ACTIONS);
      ctx.herdrVersion = c.version; ctx.compat = c; ctx.cliError = null;
      log('compat', { herdr: c.version, protocol: c.protocol, verified: c.version === PINNED_HERDR_VERSION, failing: Object.keys(c.actions).filter((n) => !c.actions[n].ok) });
    } catch (e) { ctx.compat = null; ctx.cliError = e.code || 'schema_unreadable'; }
  })().finally(() => { reading = null; }));
  await ctx.refreshCompat(true);
  const caps = capabilities();
  for (const [name, key, accepted] of [[HISTORY, 'history', '1, agents or all'], [CONTROL, 'control', '1'], [AGENT_CLICK, 'agent_click', '1'], [TAG_PANES, 'tag_panes', '1']]) {
    if (caps[key] === 'invalid') log('gate_invalid', { name, value: String(process.env[name]).slice(0, 20), effect: `${key} is off; use ${accepted}` });
  }
  log('boot', { version: config.version, herdr: ctx.herdrVersion, verified_version: PINNED_HERDR_VERSION, strict: ctx.strict, writes_enabled: ctx.writesEnabled, capabilities: caps });

  await ctx.inventory.start();
  const server = createServer({ ctx, tokenDigest, log, tunnelProbe });
  server.listen(config.port, config.host, () => log('listening', { host: config.host, port: config.port }));
  const stop = (sig) => { log('shutdown', { sig }); ctx.inventory.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
})().catch((e) => { log('fatal', { message: String(e.message) }); process.exit(1); });
