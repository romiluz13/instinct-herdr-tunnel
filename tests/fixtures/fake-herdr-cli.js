#!/usr/bin/env node
// Fake `herdr` CLI for tests: only what the portal calls.
const fs = require('fs');
const a = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const log = (o) => fs.appendFileSync(dir + '/cli-calls.jsonl', JSON.stringify(o) + '\n');
if (a[0] === '--version') { console.log('herdr ' + (process.env.FAKE_HERDR_VERSION || '0.9.3')); process.exit(0); }
if (a[0] === 'session' && a[1] === 'list') {
  let extra = []; try { extra = JSON.parse(fs.readFileSync(dir + '/extra-sessions.json', 'utf8')); } catch { /* single session */ }
  console.log(JSON.stringify({ sessions: [{ default: true, name: 'default', running: true, session_dir: dir, socket_path: dir + '/herdr.sock' }, ...extra.map((e) => ({ default: false, name: e.name, running: true, session_dir: e.dir, socket_path: e.dir + '/herdr.sock' }))] })); process.exit(0);
}
if (a[0] === 'machine' && a[1] === 'list') { console.log('[]'); process.exit(0); }
if (a.includes('pane') && a.includes('run')) { log({ argv: a, env_herdr: Object.keys(process.env).filter((k) => k.startsWith('HERDR_')) }); console.log('{"id":"cli:pane:run","result":{"type":"ok"}}'); process.exit(0); }
console.error(JSON.stringify({ error: { code: 'unsupported', message: 'fake' } })); process.exit(1);
