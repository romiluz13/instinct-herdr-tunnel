'use strict';
// Which Herdr builds may receive writes. The portal does not pin one version: it reads the installed CLI's own
// `herdr api schema --json` and refuses, per action, whatever no longer matches the parameters that action sends.
// This checks request parameters by name only (method exists, every sent field is a schema field, every field the schema
// requires is one the action always sends, CLI subcommand exists). Types, enums, nested fields, response fields and
// what a method now means are not checked; `HERDR_PORTAL_STRICT_VERSION=1` limits writes to the one
// version proven live (PINNED_HERDR_VERSION in config.js).
const herdr = require('./herdr');

// What every write's preflight sends (lib/actions.js: preflight, foregroundIsShell).
const PREFLIGHT = { 'pane.get': ['pane_id'], 'pane.read': ['pane_id', 'source', 'format', 'strip_ansi'], 'pane.process_info': ['pane_id'] };

function parseSchema(schema) {
  const oneOf = schema.schemas.request.oneOf;
  const defs = schema.schemas.request.$defs;
  const methods = new Map();
  for (const v of oneOf) {
    if (!v || !v.properties || !v.properties.method || typeof v.properties.method.const !== 'string') continue; // a variant this reader does not know: its method is simply absent, so only actions that use it are refused
    const ref = v.properties.params && v.properties.params.$ref;
    const def = (ref && defs[ref.split('/').pop()]) || {};
    methods.set(v.properties.method.const, { props: new Set(Object.keys(def.properties || {})), required: new Set(def.required || []) });
  }
  return { protocol: schema.protocol, methods };
}

// `always`: the fields every call sends; when given, the schema may not require anything beyond them.
function checkSend(index, method, sent, always) {
  const m = index.methods.get(method);
  if (!m) return `${method} is not in this Herdr's schema`;
  const unknown = sent.filter((x) => !m.props.has(x));
  if (unknown.length) return `${method} no longer accepts: ${unknown.join(', ')}`;
  if (always) { const missing = [...m.required].filter((x) => !always.includes(x)); if (missing.length) return `${method} now requires: ${missing.join(', ')}`; }
  return null;
}

// null when the action's calls still fit; otherwise a short reason. `cliOk` maps "herdr a b" to a boolean.
function checkAction(index, proof, cliOk) {
  const bad = [];
  if (proof.sock) {
    const fw = proof.forwards || { required: [] };
    bad.push(checkSend(index, proof.sock, [...(fw.required || []), ...(fw.optional || [])], fw.required || []));
  }
  for (const u of proof.uses || []) bad.push(index.methods.has(u) ? null : `${u} is not in this Herdr's schema`);
  if (proof.cli) bad.push(cliOk(proof.cli) ? null : `\`herdr ${proof.cli.join(' ')}\` is not available`);
  return bad.filter(Boolean).join('; ') || null;
}

async function probeCli(cmd) {
  try { await herdr.cli([...cmd, '--help']); return true; } catch { /* a group without --help lists its subcommands */ }
  try { return (await herdr.cli([cmd[0]])).includes(`herdr ${cmd.join(' ')}`); } catch { return false; }
}

// Reads the installed CLI once and judges every action.
async function evaluate(actions) {
  const version = await herdr.installedVersion();
  const schema = JSON.parse(await herdr.cli(['api', 'schema', '--json'], { timeoutMs: 20000, maxBuffer: 64 * 1024 * 1024 }));
  if ((await herdr.installedVersion()) !== version) throw new herdr.HerdrError('cli_changed', 'the herdr CLI changed while its schema was being read');
  const index = parseSchema(schema);
  const cliSeen = new Map();
  for (const a of Object.values(actions)) if (a.proof.cli) cliSeen.set(a.proof.cli.join(' '), await probeCli(a.proof.cli));
  const cliOk = (cmd) => cliSeen.get(cmd.join(' ')) === true;
  const pre = Object.entries(PREFLIGHT).map(([m, f]) => checkSend(index, m, f, false)).filter(Boolean).join('; ') || null;
  const judged = {};
  for (const [name, a] of Object.entries(actions)) {
    const own = checkAction(index, a.proof, cliOk);
    const reason = [own, a.write ? pre : null].filter(Boolean).join('; ') || null;
    judged[name] = reason ? { ok: false, reason } : { ok: true };
  }
  return { version, protocol: schema.protocol, actions: judged, at: new Date().toISOString() };
}

module.exports = { evaluate, parseSchema, checkAction, PREFLIGHT };
