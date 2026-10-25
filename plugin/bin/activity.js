#!/usr/bin/env node
'use strict';
// A live screen of what the portal did, read from its audit log. `--once [--lines N]` prints the newest entries and exits.
const os = require('node:os');
const feed = require('../lib/feed');

const env = process.env;
const file = feed.auditPath(env, os.homedir());
const port = Number(env.HERDR_PORTAL_PORT) || 8787;
const argv = process.argv.slice(2);
const flag = (name) => argv.indexOf(name);
const MAX_ENTRIES = 2000;

if (flag('--once') >= 0 || !process.stdout.isTTY) {
  const n = Number(argv[flag('--lines') + 1]) || 20;
  for (const e of feed.AuditTail.last(file, n)) process.stdout.write(feed.row(e, { width: 200, color: false }) + '\n');
  process.exit(0);
}

const out = process.stdout;
let entries = feed.AuditTail.last(file, 500);
const tail = new feed.AuditTail(file, { fromEnd: true });
let scroll = 0; let paused = false; let frozen = 0; let health = 'unknown'; let tunnel = feed.tunnelFrom(null, false);
const metrics = feed.metricsAddress(env);

const shown = () => (paused ? entries.slice(0, frozen) : entries);
const draw = () => {
  const lines = feed.render({ entries: shown(), width: out.columns || 80, height: out.rows || 24, scroll, paused, health, tunnel, color: !env.NO_COLOR });
  out.write('\x1b[H' + lines.map((l) => l + '\x1b[K').join('\r\n'));
};

const probe = async () => {
  try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }); health = r.ok ? 'up' : 'down'; } catch { health = 'down'; }
  try { const r = await fetch(`http://${metrics}/ready`, { signal: AbortSignal.timeout(1500) }); tunnel = feed.tunnelFrom({ status: r.status, body: await r.text() }, tunnel.seen); } catch { tunnel = feed.tunnelFrom(null, tunnel.seen); }
  draw();
};

const quit = () => {
  clearInterval(poller); clearInterval(prober);
  out.write('\x1b[?25h\x1b[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
};

const page = () => Math.max(1, (out.rows || 24) - 4);
const KEYS = {
  q: quit, '\x03': quit, '\x1b': quit,
  p: () => { paused = !paused; frozen = entries.length; },
  '\x1b[A': () => { scroll += 1; }, k: () => { scroll += 1; },
  '\x1b[B': () => { scroll = Math.max(0, scroll - 1); }, j: () => { scroll = Math.max(0, scroll - 1); },
  '\x1b[5~': () => { scroll += page(); }, '\x1b[6~': () => { scroll = Math.max(0, scroll - page()); },
  '\x1b[F': () => { scroll = 0; }, '\x1b[4~': () => { scroll = 0; }, G: () => { scroll = 0; },
};

out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
process.stdin.on('data', (k) => { if (Object.hasOwn(KEYS, k)) KEYS[k](); draw(); });
out.on('resize', () => { out.write('\x1b[2J'); draw(); });
process.on('SIGTERM', quit); process.on('SIGHUP', quit);

const poller = setInterval(() => {
  const fresh = tail.poll();
  if (!fresh.length) return;
  entries = entries.concat(fresh).slice(-MAX_ENTRIES);
  if (scroll > 0 && !paused) scroll += fresh.length; // keep the reader's place while the log grows
  draw();
}, 500);
const prober = setInterval(probe, 5000);
probe();
