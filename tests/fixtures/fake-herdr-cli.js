#!/usr/bin/env node
// Fake `herdr` CLI for tests: only what the portal calls.
const fs = require('fs');
const a = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const log = (o) => fs.appendFileSync(dir + '/cli-calls.jsonl', JSON.stringify(o) + '\n');
const readOpt = (f) => { try { return fs.readFileSync(dir + '/' + f, 'utf8').trim(); } catch { return null; } };
// version.txt lets a test "upgrade" the CLI while the portal runs; schema-patch.json lets it drift the schema.
if (a[0] === '--version') { console.log('herdr ' + (readOpt('version.txt') || process.env.FAKE_HERDR_VERSION || '0.9.3')); process.exit(0); }
if (a[0] === 'api' && a[1] === 'schema') {
  if (readOpt('no-schema.txt')) { console.error(JSON.stringify({ error: { code: 'schema_unreadable', message: 'fake' } })); process.exit(1); }
  // Built from what the portal says it sends (every action's `forwards` plus the write preflight), so the fake CLI and
  // the portal agree until a test changes the schema on purpose.
  const { ACTIONS } = require('../../lib/actions'); const { PREFLIGHT } = require('../../lib/compat');
  const m = {};
  const add = (name, fields, required) => { m[name] = m[name] || { props: new Set(), required: new Set() }; fields.forEach((f) => m[name].props.add(f)); required.forEach((f) => m[name].required.add(f)); };
  for (const x of Object.values(ACTIONS)) { const p = x.proof; if (p.sock) { const f = p.forwards || { required: [] }; add(p.sock, [...(f.required || []), ...(f.optional || [])], f.required || []); } for (const u of p.uses || []) add(u, [], []); }
  for (const [name, f] of Object.entries(PREFLIGHT)) add(name, f, []);
  let patch = {}; try { patch = JSON.parse(readOpt('schema-patch.json') || '{}'); } catch { /* none */ }
  for (const d of patch.drop || []) delete m[d];
  for (const [name, f] of Object.entries(patch.dropField || {})) if (m[name]) { m[name].props.delete(f); m[name].required.delete(f); }
  for (const [name, f] of Object.entries(patch.addRequired || {})) if (m[name]) { m[name].props.add(f); m[name].required.add(f); }
  const defs = {}; const oneOf = [];
  for (const [name, v] of Object.entries(m)) { const d = name.replace(/\W/g, '_') + 'Params'; defs[d] = { type: 'object', properties: Object.fromEntries([...v.props].map((f) => [f, {}])), required: [...v.required] }; oneOf.push({ properties: { method: { const: name }, params: { $ref: '#/schemas/request/$defs/' + d } } }); }
  console.log(JSON.stringify({ protocol: Number(readOpt('protocol.txt') || 22), schemas: { request: { oneOf, $defs: defs } } })); process.exit(0);
}
if (a.includes('--help') || (a.length === 1 && a[0] === 'pane')) { if (readOpt('no-pane-run.txt') && a.includes('run')) process.exit(1); console.log('Usage: herdr ' + a.filter((x) => x !== '--help').join(' ')); process.exit(0); }
if (a[0] === 'session' && a[1] === 'list') {
  let extra = []; try { extra = JSON.parse(fs.readFileSync(dir + '/extra-sessions.json', 'utf8')); } catch { /* single session */ }
  console.log(JSON.stringify({ sessions: [{ default: true, name: 'default', running: true, session_dir: dir, socket_path: dir + '/herdr.sock' }, ...extra.map((e) => ({ default: false, name: e.name, running: true, session_dir: e.dir, socket_path: e.dir + '/herdr.sock' }))] })); process.exit(0);
}
if (a[0] === 'machine' && a[1] === 'list') { console.log('[]'); process.exit(0); }
if (a.includes('pane') && a.includes('run')) { log({ argv: a, env_herdr: Object.keys(process.env).filter((k) => k.startsWith('HERDR_')) }); console.log('{"id":"cli:pane:run","result":{"type":"ok"}}'); process.exit(0); }
console.error(JSON.stringify({ error: { code: 'unsupported', message: 'fake' } })); process.exit(1);
