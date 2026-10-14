#!/usr/bin/env node
'use strict';
// End-to-end proof for put_file against a running portal, local or through a tunnel.
//   node scripts/put-file-proof.js --base https://x.example.org
// Everything is written under one random subdirectory of the drop root, which is removed at the end. The bearer token
// comes from the 0600 token file and is never printed; the base address is not printed or saved. When the drop root is
// readable from this machine (the usual case: the portal runs here) the response hash is also compared with `shasum -a 256`
// of the file on disk.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { config } = require('../lib/config');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const base = (args.base || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
const dropDir = args['drop-dir'] || config.dropDir;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dir = 'proof-' + crypto.randomBytes(5).toString('hex');
let failures = 0;
const check = (name, ok, note = '') => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? '  — ' + note : ''}`); return ok; };

async function post(body, { tok = token, raw } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(base + '/api/herdr/put_file', { method: 'POST', headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' }, body: raw || JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, ms: Date.now() - t0 };
  } catch (e) { return { status: 0, json: null, error: (e.cause && e.cause.code) || e.code || e.message, ms: Date.now() - t0 }; }
}
const put = (rel, content, extra = {}) => post({ path: `${dir}/${rel}`, content, sha256: sha(Buffer.from(content, 'utf8')), ...extra });
const onDisk = (p) => { try { return fs.readFileSync(p); } catch { return null; } };

(async () => {
  const health = await fetch(base + '/healthz'); check('GET /healthz reachable without a token', health.status === 200 && (await health.json()).portal === 'up');
  let local = null; try { local = fs.realpathSync(dropDir); } catch { /* drop root not on this machine */ }

  for (const [label, n] of [['small file', 12], ['18 KB file', 18 * 1024], ['exactly 262144 bytes', 262144]]) {
    const unit = 'proof ' + label + '\n'; const content = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const r = await put(`f${n}.txt`, content);
    let ok = r.status === 200 && r.json && r.json.ok === true && r.json.bytes === n && r.json.sha256 === sha(Buffer.from(content));
    let note = `${r.ms} ms`;
    if (ok && local) {
      const file = r.json.path; const st = fs.statSync(file);
      const shasum = execFileSync('/usr/bin/shasum', ['-a', '256', file], { encoding: 'utf8' }).split(' ')[0];
      ok = shasum === r.json.sha256 && (st.mode & 0o7777) === 0o600 && st.size === n && file.startsWith(local + path.sep);
      note += `; response sha256 == shasum of the file on disk: ${shasum === r.json.sha256}; mode ${(st.mode & 0o7777).toString(8)}`;
    }
    check(`${label} written, size and sha256 confirmed`, ok, r.error || note + (r.status === 200 ? '' : ` status ${r.status}`));
  }
  const tooBig = await put('big.txt', 'y'.repeat(262145)); check('262145 bytes refused with 413 content_too_large', tooBig.status === 413 && tooBig.json && tooBig.json.error === 'content_too_large');
  const kb300 = await put('big2.txt', 'y'.repeat(300 * 1024)); check('300 KB body reaches the handler (413 content_too_large, not body_too_large or a proxy error)', kb300.status === 413 && kb300.json && kb300.json.error === 'content_too_large', kb300.error || `status ${kb300.status}`);
  const huge = await post(null, { raw: JSON.stringify({ path: 'a.txt', content: 'z'.repeat(3 * 1024 * 1024), sha256: 'a'.repeat(64) }) });
  check('a 3 MiB body gets a clean 413 body_too_large, not a reset or a 502', huge.status === 413 && huge.json && huge.json.error === 'body_too_large', huge.error || `status ${huge.status}`);
  const prompt = await fetch(base + '/api/herdr/agent_prompt', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'p'.repeat(18 * 1024) }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), (e) => ({ status: 0, error: e.message }));
  check('an 18 KB body to another action also gets a clean 413 (the original 502)', prompt.status === 413 && prompt.json && prompt.json.error && prompt.json.error.code === 'body_too_large', prompt.error || `status ${prompt.status}`);

  const base1 = await put('same.txt', 'one'); const dup = await put('same.txt', 'two');
  check('mode create over an existing file is refused (409 exists)', base1.status === 200 && dup.status === 409 && dup.json.error === 'exists');
  const mism = await post({ path: `${dir}/same.txt`, content: 'three', sha256: sha(Buffer.from('not three')), mode: 'overwrite' });
  check('hash mismatch refused (422) and the existing file is untouched', mism.status === 422 && (!local || (onDisk(base1.json.path) || Buffer.alloc(0)).toString() === 'one'));
  const over = await put('same.txt', 'three', { mode: 'overwrite' });
  check('mode overwrite replaces the file', over.status === 200 && (!local || (onDisk(over.json.path) || Buffer.alloc(0)).toString() === 'three'));

  for (const p of ['../x', `${dir}/../../x`, '/etc/hosts', '%2e%2e/x', 'a\u0000b', '.hidden', `${dir}/a b`]) {
    const r = await post({ path: p, content: 'x', sha256: sha(Buffer.from('x')) });
    check(`path refused: ${JSON.stringify(p)}`, (r.status === 400 || r.status === 403) && r.json && r.json.ok === false, r.error || `status ${r.status}`);
  }
  const bad = await post(null, { raw: Buffer.concat([Buffer.from('{"path":"u.txt","sha256":"' + 'a'.repeat(64) + '","content":"ab'), Buffer.from([0xff]), Buffer.from('"}')]) });
  check('invalid UTF-8 bytes refused (400 content_not_utf8)', bad.status === 400 && bad.json && bad.json.error === 'content_not_utf8', bad.error || `status ${bad.status}`);
  const lone = await post(null, { raw: `{"path":"u.txt","sha256":"${'a'.repeat(64)}","content":"\\ud800"}` });
  check('a lone surrogate refused (400 content_not_utf8)', lone.status === 400 && lone.json && lone.json.error === 'content_not_utf8');
  const noTok = await post({ path: 'a.txt', content: 'x', sha256: sha(Buffer.from('x')) }, { tok: null }); check('no token refused (401)', noTok.status === 401 && noTok.json && noTok.json.ok === false);
  const badTok = await post({ path: 'a.txt', content: 'x', sha256: sha(Buffer.from('x')) }, { tok: 'w'.repeat(43) }); check('wrong token refused (401)', badTok.status === 401);
  if (local) check('nothing was written outside the proof directory', !fs.existsSync(path.join(local, '..', 'x')) && !fs.existsSync(path.join(local, 'x')) && fs.readdirSync(local).filter((n) => n.startsWith('proof-')).length >= 1);

  if (local && /^proof-[0-9a-f]{10}$/.test(dir)) fs.rmSync(path.join(local, dir), { recursive: true, force: true }); // only the directory this run created
  console.log(local ? `cleaned up ${dir}` : `left in place on the portal machine: ${dir} (drop root not readable from here)`);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('proof run failed:', e.message); process.exit(2); });
