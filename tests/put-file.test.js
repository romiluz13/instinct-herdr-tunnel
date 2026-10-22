'use strict';
// put_file against a real portal process (fake Herdr behind it) plus direct tests of lib/dropbox.js with fault injection.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ROOT, TOKEN, req, setup } = require('./fixtures/harness');
const { putFile } = require('../lib/dropbox');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const body = (content, extra = {}) => ({ path: 'a.txt', content, sha256: sha(Buffer.from(content, 'utf8')), ...extra });
const put = (c, b, opts) => req(c.port, 'POST', '/api/herdr/put_file', { body: b, ...opts });
const inbox = (c) => path.join(c.dir, 'state', 'inbox');
const real = (p) => fs.realpathSync(p);
const ls = (d) => fs.readdirSync(d, { recursive: true });
const mode = (p) => fs.statSync(p).mode & 0o7777;

// A request whose body bytes are given verbatim (the harness helper always sends JSON.stringify output).
function raw(port, buf, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/herdr/put_file', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', (e) => resolve({ error: e.code }));
    r.end(buf);
  });
}

test('the drop root is created with mode 0700 and a written file is 0600 with the response taken from disk', async (t) => {
  const c = await setup(t);
  assert.ok(fs.statSync(inbox(c)).isDirectory()); assert.equal(mode(inbox(c)), 0o700);
  const content = 'héllo wörld ✓ 日本語\n';
  const r = await put(c, body(content, { action: 'put_file', sha256: sha(Buffer.from(content)).toUpperCase() }));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json).sort(), ['bytes', 'intent_id', 'mode_used', 'ok', 'path', 'sha256']);
  const file = path.join(real(inbox(c)), 'a.txt');
  assert.equal(r.json.path, file); assert.equal(r.json.mode_used, 'create'); assert.equal(r.json.ok, true);
  const disk = fs.readFileSync(file);
  assert.equal(r.json.bytes, disk.length); assert.equal(r.json.sha256, sha(disk)); assert.equal(disk.toString('utf8'), content);
  assert.equal(mode(file), 0o600, 'no execute bit, no group or other access');
  assert.deepEqual(ls(inbox(c)), ['a.txt'], 'no temp file is left behind');
});

test('sizes: small, 18 KB and exactly 262144 bytes are written; 262145 and 300 KB are refused with 413 and write nothing', async (t) => {
  const c = await setup(t);
  for (const [i, n] of [[1, 5], [2, 18 * 1024], [3, 262144]]) {
    const content = 'x'.repeat(n);
    const r = await put(c, body(content, { path: `f${i}.txt` }));
    assert.equal(r.status, 200, `${n}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.bytes, n);
    const file = path.join(real(inbox(c)), `f${i}.txt`);
    assert.equal(sha(fs.readFileSync(file)), r.json.sha256); assert.equal(mode(file), 0o600);
  }
  const before = ls(inbox(c)).sort();
  for (const n of [262145, 300 * 1024]) {
    const r = await put(c, body('y'.repeat(n), { path: 'big.txt' }));
    assert.equal(r.status, 413, String(n)); assert.equal(r.json.error, 'content_too_large'); assert.equal(r.json.ok, false);
  }
  const multi = await put(c, body('é'.repeat(131073), { path: 'multi.txt' })); // 262146 bytes in 131073 characters: the cap is on bytes
  assert.equal(multi.status, 413); assert.equal(multi.json.error, 'content_too_large');
  assert.deepEqual(ls(inbox(c)).sort(), before, 'nothing was written');
});

test('worst-case JSON escaping of a maximal file still reaches the handler and is written', async (t) => {
  const c = await setup(t);
  const content = '\u0001'.repeat(262144); // each byte becomes a 6-byte \u0001 escape: about 1.5 MiB of request body
  const b = JSON.stringify(body(content));
  assert.ok(b.length > 1.4 * 1024 * 1024 && b.length < 2 * 1024 * 1024);
  const r = await raw(c.port, Buffer.from(b));
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.json.bytes, 262144);
});

test('a body over the limit is answered with 413 and is not reset before the answer (the 502 behind cloudflared)', async (t) => {
  const c = await setup(t);
  const big = Buffer.from(JSON.stringify({ path: 'a.txt', content: 'z'.repeat(3 * 1024 * 1024), sha256: 'a'.repeat(64) }));
  const r = await raw(c.port, big);
  assert.equal(r.error, undefined, 'the client got an answer, not ECONNRESET');
  assert.equal(r.status, 413); assert.equal(r.json.error, 'body_too_large');
  // the other actions keep their 16 KiB limit and get the same clean answer for an 18 KB prompt
  const o = await req(c.port, 'POST', '/api/herdr/agent_prompt', { body: { session: 'default', pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), text: 'p'.repeat(18 * 1024) } });
  assert.equal(o.status, 413); assert.equal(o.json.error.code, 'body_too_large');
  assert.equal(c.herdr.writes().length, 0);
  assert.equal((await req(c.port, 'GET', '/api/health')).status, 200, 'the portal is fine afterwards');
});

test('a chunked upload over the limit (no Content-Length) also gets its 413 before the connection closes', async (t) => {
  const c = await setup(t);
  const r = await new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/api/herdr/put_file', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b), te: res.headers['transfer-encoding'], cl: res.headers['content-length'] }));
    });
    q.on('error', (e) => resolve({ error: e.code }));
    q.write('{"path":"a.txt","sha256":"' + 'a'.repeat(64) + '","content":"');
    let sent = 0; const chunk = Buffer.alloc(64 * 1024, 'q');
    const pump = () => { while (sent < 3 * 1024 * 1024) { sent += chunk.length; if (!q.write(chunk)) return q.once('drain', pump); } q.end('"}'); };
    pump();
  });
  assert.equal(r.error, undefined, 'the client got an answer, not a reset');
  assert.equal(r.status, 413); assert.equal(r.json.error, 'body_too_large');
});

test('hash mismatch writes nothing and leaves an existing file untouched', async (t) => {
  const c = await setup(t);
  assert.equal((await put(c, body('original'))).status, 200);
  const file = path.join(real(inbox(c)), 'a.txt'); const before = fs.statSync(file);
  for (const m of ['create', 'overwrite']) {
    const r = await put(c, { ...body('replacement'), sha256: sha(Buffer.from('something else')), mode: m });
    assert.equal(r.status, 422); assert.equal(r.json.error, 'sha256_mismatch');
  }
  const fresh = await put(c, { ...body('new'), path: 'sub/dir/new.txt', sha256: 'b'.repeat(64) });
  assert.equal(fresh.status, 422);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.equal(fs.statSync(file).ino, before.ino);
  assert.deepEqual(ls(inbox(c)).sort(), ['a.txt'], 'a refused request creates no directories either');
  assert.equal((await put(c, { ...body('x'), sha256: 'not-hex' })).json.error, 'sha256_invalid');
});

test('path traversal and odd paths are refused and nothing appears outside the drop root', async (t) => {
  const c = await setup(t);
  const outside = path.join(c.dir, 'x'); const abs = path.join(c.dir, 'outside.txt');
  const bad = ['../x', 'inbox/../../x', 'a/../../x', '/etc/hostname', abs, path.join(inbox(c), '..', 'x'), '%2e%2e/x', '%2e%2e%2fx', 'a\u0000b', '', '.', '..', 'a//b', 'a/./b', 'a/', '.hidden', 'sub/.hidden', '.put_file-0.tmp', 'with space', 'a'.repeat(256), 'a/'.repeat(17) + 'f', 'a\\b', 'é.txt', 'a\nb', 'x'.repeat(1025)];
  for (const p of bad) {
    const r = await put(c, body('data', { path: p }));
    assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(p)} -> ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.ok, false);
  }
  assert.equal((await put(c, body('data', { path: 7 }))).json.error, 'path_invalid');
  assert.equal((await put(c, body('data', { path: abs }))).json.error, 'path_outside_root');
  assert.ok(!fs.existsSync(outside) && !fs.existsSync(abs));
  assert.deepEqual(ls(inbox(c)), [], 'nothing was written inside either');
  assert.deepEqual(fs.readdirSync(c.dir).filter((n) => n === 'x' || n === 'outside.txt'), []);
  // a relative path and the same file spelled absolutely (the configured root, with or without symlinked ancestors) both work
  assert.equal((await put(c, body('ok', { path: 'sub/ok.txt' }))).status, 200);
  assert.equal((await put(c, body('ok2', { path: path.join(inbox(c), 'sub', 'ok2.txt') }))).status, 200);
  assert.equal((await put(c, body('ok3', { path: path.join(real(inbox(c)), 'ok3.txt') }))).status, 200);
});

test('symbolic links are refused wherever they sit and nothing is written through them', async (t) => {
  const c = await setup(t);
  const root = inbox(c); const out = path.join(c.dir, 'outside'); fs.mkdirSync(out);
  const secret = path.join(out, 'secret.txt'); fs.writeFileSync(secret, 'untouched');
  fs.writeFileSync(path.join(root, 'real.txt'), 'inside'); fs.mkdirSync(path.join(root, 'realdir'));
  fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'link-file'));  // symlink to a file inside the root
  fs.symlinkSync(path.join(root, 'realdir'), path.join(root, 'link-dir'));    // symlink to a directory inside the root
  fs.symlinkSync(secret, path.join(root, 'link-out-file'));                   // symlink to a file outside
  fs.symlinkSync(out, path.join(root, 'link-out-dir'));                       // symlink to a directory outside
  fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'));
  fs.mkdirSync(path.join(root, 'realdir', 'deep'));
  fs.symlinkSync(out, path.join(root, 'realdir', 'deep', 'escape'));
  const cases = ['link-file', 'link-dir/f.txt', 'link-out-file', 'link-out-dir/f.txt', 'link-out-dir/new/f.txt', 'dangling', 'realdir/deep/escape/f.txt'];
  for (const p of cases) for (const m of ['create', 'overwrite']) {
    const r = await put(c, body('pwned', { path: p, mode: m }));
    assert.equal(r.status, 403, `${p} ${m} -> ${r.status} ${JSON.stringify(r.json)}`); assert.equal(r.json.error, 'symlink_refused');
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'untouched'); assert.deepEqual(fs.readdirSync(out), ['secret.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'inside');
  assert.deepEqual(fs.readdirSync(path.join(root, 'realdir')), ['deep']);
  assert.equal((await put(c, body('x', { path: 'realdir' }))).json.error, 'is_directory');
  assert.equal((await put(c, body('x', { path: 'real.txt/child' }))).json.error, 'not_a_directory');
  const absLink = await put(c, body('x', { path: path.join(root, 'link-out-file') }));
  assert.equal(absLink.status, 403);
  assert.ok(!ls(root).some((n) => n.includes('.put_file-')), 'no temp files');
});

test('content that is not UTF-8 is refused: invalid bytes in the body, and a lone surrogate in the JSON', async (t) => {
  const c = await setup(t);
  const head = Buffer.from('{"path":"u.txt","sha256":"' + 'a'.repeat(64) + '","content":"ab');
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xc3, 0x28]), Buffer.from([0xe2, 0x82]), Buffer.from([0xed, 0xa0, 0x80])]) {
    const r = await raw(c.port, Buffer.concat([head, bad, Buffer.from('"}')]));
    assert.equal(r.status, 400, bad.toString('hex')); assert.equal(r.json.error, 'content_not_utf8');
  }
  for (const s of ['\\ud800', 'a\\udc00b', '\\ud83d x']) {
    const r = await raw(c.port, Buffer.from(`{"path":"u.txt","sha256":"${'a'.repeat(64)}","content":"${s}"}`));
    assert.equal(r.status, 400, s); assert.equal(r.json.error, 'content_not_utf8');
  }
  const pair = await raw(c.port, Buffer.from(`{"path":"u.txt","sha256":"${sha(Buffer.from('😄'))}","content":"\\ud83d\\ude04"}`));
  assert.equal(pair.status, 200, 'a valid surrogate pair is fine');
  assert.deepEqual(ls(inbox(c)), ['u.txt']);
});

test('create fails over an existing file; overwrite replaces it atomically (new inode)', async (t) => {
  const c = await setup(t);
  const first = await put(c, body('one'));
  assert.equal(first.status, 200);
  const file = first.json.path; const ino1 = fs.statSync(file).ino;
  for (const extra of [{}, { mode: 'create' }]) {
    const r = await put(c, body('two', extra)); assert.equal(r.status, 409); assert.equal(r.json.error, 'exists');
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'one');
  const over = await put(c, body('two!', { mode: 'overwrite' }));
  assert.equal(over.status, 200); assert.equal(over.json.mode_used, 'overwrite');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two!'); assert.notEqual(fs.statSync(file).ino, ino1, 'replaced by rename, not rewritten in place');
  assert.equal(mode(file), 0o600);
  fs.chmodSync(file, 0o755);
  assert.equal((await put(c, body('three', { mode: 'overwrite' }))).status, 200);
  assert.equal(mode(file), 0o600, 'an executable file is replaced by a non-executable one');
  assert.equal((await put(c, body('x', { mode: 'append' }))).status, 400);
  assert.equal((await put(c, body('x', { action: 'pane_run' }))).status, 400);
  assert.equal((await put(c, { ...body('x'), extra: 1 })).json.error, 'unknown_param');
  assert.equal((await put(c, { path: 'a.txt', content: 'x' })).json.error, 'missing_param');
  assert.deepEqual(ls(inbox(c)), ['a.txt']);
});

test('subdirectories are created with 0700; two concurrent creates of the same file: exactly one wins', async (t) => {
  const c = await setup(t);
  const r = await put(c, body('deep', { path: 'p/q/r/f.txt' }));
  assert.equal(r.status, 200);
  for (const d of ['p', 'p/q', 'p/q/r']) assert.equal(mode(path.join(inbox(c), d)), 0o700, d);
  const race = await Promise.all(Array.from({ length: 12 }, (_, i) => put(c, body('v' + i, { path: 'race/one.txt' }))));
  assert.equal(race.filter((x) => x.status === 200).length, 1);
  assert.ok(race.filter((x) => x.status !== 200).every((x) => x.status === 409 && x.json.error === 'exists'));
  assert.equal(ls(path.join(inbox(c), 'race')).length, 1, 'no temp files left by the losers');
});

test('a drop root that others can write to is refused', async (t) => {
  const c = await setup(t);
  fs.chmodSync(inbox(c), 0o777);
  const r = await put(c, body('x')); assert.equal(r.status, 503); assert.equal(r.json.error, 'drop_root_unsafe');
  fs.chmodSync(inbox(c), 0o700);
  assert.equal((await put(c, body('x'))).status, 200);
});

test('put_file keeps answering in under a second while a Herdr call is stuck', async (t) => {
  const c = await setup(t);
  c.herdr.state.delayMs['pane.get'] = 3000; // every pane read now takes 3 s: the prompt below sits in its preflight
  const t0 = Date.now();
  const slow = req(c.port, 'POST', '/api/herdr/agent_prompt', { body: { session: 'default', pane_id: 'w1:p2', expect_terminal_id: 'term_aa02', request_id: 'req-' + crypto.randomUUID(), idempotency_key: 'idem-' + crypto.randomUUID(), text: 'hello agent' } });
  await new Promise((r) => setTimeout(r, 300));
  const times = [];
  for (const n of [10, 18 * 1024, 262144]) {
    const s = Date.now(); const r = await put(c, body('k'.repeat(n), { path: `busy-${n}.txt` }));
    times.push(Date.now() - s); assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.ok(Date.now() - t0 < 2500, 'the slow call was still running while put_file answered');
  assert.ok(times.every((ms) => ms < 1000), 'put_file answered in under 1 s each time: ' + times.join(', ') + ' ms');
  const done = await slow;
  assert.ok(Date.now() - t0 >= 2900, 'the stuck call really was stuck for about 3 s');
  assert.equal(done.status, 200);
  assert.equal((await req(c.port, 'GET', '/api/herdr/ping?session=default')).status, 200);
  c.herdr.state.delayMs = {};
  // and with Herdr refusing everything
  c.herdr.state.errorOn['ping'] = 'internal'; c.herdr.state.hangOn = 'pane.get';
  assert.equal((await put(c, body('still works', { path: 'down.txt' }))).status, 200);
});

test('authentication: no token or a wrong token is refused and writes nothing', async (t) => {
  const c = await setup(t);
  const none = await put(c, body('x'), { token: null }); assert.equal(none.status, 401); assert.equal(none.json.ok, false); assert.equal(none.json.error, 'unauthorized');
  const wrong = await put(c, body('x'), { token: 'w'.repeat(43) }); assert.equal(wrong.status, 401);
  assert.equal((await req(c.port, 'GET', '/api/herdr/put_file')).status, 405);
  assert.equal((await put(c, body('x'), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await put(c, body('x'), { headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.deepEqual(ls(inbox(c)), []);
});

test('audit: one line per call, accepted or refused, and never the content', async (t) => {
  const c = await setup(t);
  const marker = 'MARKER-' + crypto.randomBytes(6).toString('hex');
  const calls = [
    body(marker + ' ok', { path: 'ok.txt' }),
    { ...body(marker + ' bad hash', { path: 'm.txt' }), sha256: 'c'.repeat(64) },
    body(marker + ' traversal', { path: '../x' }),
    body(marker + ' dup', { path: 'ok.txt' }),
    body(marker + ' dup', { path: 'ok.txt', mode: 'overwrite' }),
    { path: 'nocontent.txt' },
    { ...body(marker, { path: 'a'.repeat(300) + '\n\u0000forged "line"' }) },
  ];
  const statuses = [];
  for (const b of calls) statuses.push((await put(c, b)).status);
  assert.deepEqual(statuses, [200, 422, 400, 409, 200, 400, 400]);
  const lines = fs.readFileSync(path.join(c.dir, 'logs', 'audit.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, calls.length, 'exactly one line per call');
  assert.ok(!lines.join('\n').includes(marker), 'content never reaches the audit log');
  const rows = lines.map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.action === 'herdr.put_file' && /^\d{4}-/.test(r.timestamp)));
  assert.deepEqual(rows.map((r) => r.result), ['written', 'rejected', 'rejected', 'rejected', 'written', 'rejected', 'rejected']);
  assert.deepEqual(rows.map((r) => r.http_status), statuses);
  assert.deepEqual(rows.map((r) => r.error_code), [null, 'sha256_mismatch', 'path_invalid', 'exists', null, 'missing_param', 'path_invalid']);
  const file = path.join(real(inbox(c)), 'ok.txt');
  assert.equal(rows[0].path, file); assert.equal(rows[0].bytes, Buffer.byteLength(marker + ' ok')); assert.equal(rows[0].sha256, sha(Buffer.from(marker + ' ok')));
  assert.equal(rows[2].path, null, 'nothing resolved for a refused path'); assert.equal(rows[2].path_requested, '../x');
  assert.ok(rows[6].path_requested.length <= 200 && !/[\u0000-\u001f]/.test(rows[6].path_requested), 'the requested path is bounded and has no control characters');
  assert.equal(rows[4].mode, 'overwrite');
  const tail = await req(c.port, 'GET', '/api/herdr/audit_tail?n=3');
  assert.equal(tail.status, 200); assert.equal(tail.json.entries.length, 3);
});

test('put_file is subject to the same per-client rate limit as every other action', async (t) => {
  const c = await setup(t);
  let limited = null;
  for (let i = 0; i < 260 && !limited; i++) { const r = await put(c, { ...body('x', { path: 'r.txt' }), sha256: 'd'.repeat(64) }); if (r.status === 429) limited = r; }
  assert.ok(limited, 'a 429 appears within 260 requests');
  assert.equal(limited.json.error, 'rate_limited');
  assert.deepEqual(ls(inbox(c)), []);
});

test('an unwritable audit log stops put_file before anything is written', async () => {
  const { dispatch } = require('../lib/actions');
  await assert.rejects(dispatch({ audit: { healthy: false, append() { throw new Error('disk full'); } } }, 'herdr.put_file', 'POST', body('x')), (e) => e.status === 503 && e.code === 'audit_unavailable');
});

// ---------------- lib/dropbox.js directly: faults between the temp write and the publish ----------------
function scratch(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-drop-')); const root = path.join(d, 'inbox'); fs.mkdirSync(root, { mode: 0o700 });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { d, root, file: path.join(fs.realpathSync(root), 'f.txt') };
}
const pf = (content, extra = {}) => ({ path: 'f.txt', content, sha256: sha(Buffer.from(content)), ...extra });

test('a failure between the temp write and the publish leaves the target unchanged or absent and removes the temp file', async (t) => {
  const s = scratch(t);
  const boom = { beforeCommit: async ({ tmp }) => { assert.ok(fs.existsSync(tmp), 'the temp file is complete and durable here'); assert.equal(fs.readFileSync(tmp, 'utf8'), 'new content'); throw new Error('simulated failure'); } };
  await assert.rejects(putFile(s.root, pf('new content'), boom), (e) => e.code === 'write_failed' && e.status === 500);
  assert.deepEqual(fs.readdirSync(s.root), [], 'target absent, temp removed');
  await putFile(s.root, pf('old content'));
  await assert.rejects(putFile(s.root, pf('new content', { mode: 'overwrite' }), boom), (e) => e.code === 'write_failed');
  assert.equal(fs.readFileSync(s.file, 'utf8'), 'old content');
  assert.deepEqual(fs.readdirSync(s.root), ['f.txt']);
  await assert.rejects(putFile(s.root, pf('x', { mode: 'overwrite' }), { beforeCommit: async () => { fs.rmSync(s.file); fs.mkdirSync(s.file); } }), (e) => e.code === 'write_failed'); // the destination became a directory in the meantime
  assert.ok(fs.statSync(s.file).isDirectory());
  assert.deepEqual(fs.readdirSync(s.root).filter((n) => n.startsWith('.put_file-')), []);
});

test('a directory swapped for a symlink after the checks passed is still caught before anything is written', async (t) => {
  const s = scratch(t);
  const out = path.join(s.d, 'outside'); fs.mkdirSync(out);
  fs.mkdirSync(path.join(s.root, 'sub'));
  const swap = { afterChecks: async () => { fs.rmdirSync(path.join(s.root, 'sub')); fs.symlinkSync(out, path.join(s.root, 'sub')); } };
  await assert.rejects(putFile(s.root, pf('data', { path: 'sub/f.txt' }), swap), (e) => e.code === 'symlink_refused');
  assert.deepEqual(fs.readdirSync(out), [], 'nothing was written through the swapped link');
});

test('a writer killed with SIGKILL between the temp write and the publish never exposes partial content', async (t) => {
  const s = scratch(t);
  await putFile(s.root, pf('A'.repeat(100000)));
  const script = `const { putFile } = require(${JSON.stringify(path.join(ROOT, 'lib', 'dropbox.js'))});
    const c = 'B'.repeat(200000);
    putFile(${JSON.stringify(s.root)}, { path: 'f.txt', content: c, sha256: require('crypto').createHash('sha256').update(c).digest('hex'), mode: 'overwrite' },
      { beforeCommit: async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); } });`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const sig = await new Promise((r) => child.on('exit', (code, signal) => r(signal)));
  assert.equal(sig, 'SIGKILL');
  assert.equal(fs.readFileSync(s.file, 'utf8'), 'A'.repeat(100000), 'the previous complete file is still there');
  const left = fs.readdirSync(s.root).filter((n) => n !== 'f.txt');
  assert.ok(left.every((n) => /^\.put_file-[0-9a-f]{16}\.tmp$/.test(n)), 'only a dot-named temp file can remain after a hard kill: ' + left);
  // and a first-time write killed the same way leaves no file under the requested name
  const script2 = script.replace("path: 'f.txt'", "path: 'g.txt'");
  const c2 = spawn(process.execPath, ['-e', script2], { stdio: 'ignore' }); await new Promise((r) => c2.on('exit', r));
  assert.ok(!fs.existsSync(path.join(s.root, 'g.txt')));
});

test('readers racing repeated overwrites only ever see a complete version', async (t) => {
  const s = scratch(t);
  const versions = ['A', 'B', 'C'].map((ch) => ch.repeat(262144));
  const ok = new Set(versions.map((v) => sha(Buffer.from(v))));
  await putFile(s.root, pf(versions[0]));
  let stop = false; const seen = new Set(); let reads = 0; const bad = [];
  const reader = (async () => {
    while (!stop) {
      let data; try { data = fs.readFileSync(s.file); } catch (e) { bad.push('read error ' + e.code); continue; }
      reads += 1; const h = sha(data); seen.add(h);
      if (!ok.has(h)) bad.push(`partial or mixed: ${data.length} bytes`);
      await new Promise((r) => setImmediate(r));
    }
  })();
  for (let i = 0; i < 40; i++) await putFile(s.root, pf(versions[i % 3], { mode: 'overwrite' }));
  stop = true; await reader;
  assert.deepEqual(bad, []); assert.ok(reads > 20 && seen.size >= 2, `the reader saw ${reads} reads of ${seen.size} versions`);
  assert.deepEqual(fs.readdirSync(s.root), ['f.txt']);
});

test('the response reports what is on disk even if it differs from the request (read back, not echoed)', async (t) => {
  const s = scratch(t);
  // tamper with the published file between the publish and the read-back by replacing it in beforeCommit's aftermath: a hook
  // that swaps the temp file's content makes the result differ from the received bytes, and the call must say so.
  await assert.rejects(putFile(s.root, pf('what was sent'), { beforeCommit: async ({ tmp }) => fs.writeFileSync(tmp, 'what is on disk') }), (e) => e.code === 'committed_unverified' && e.status === 500 && e.extra.reason === 'readback_mismatch');
});

const committedUnverified = (reason) => (e) => {
  assert.equal(e.status, 500); assert.equal(e.code, 'committed_unverified');
  assert.deepEqual({ committed: e.extra.committed, verified: e.extra.verified, retryable: e.extra.retryable, reason: e.extra.reason }, { committed: true, verified: false, retryable: false, reason });
  assert.match(e.extra.sha256, /^[0-9a-f]{64}$/); assert.ok(e.extra.path.endsWith('.txt'));
  return true;
};

test('a failure after the publish keeps the new bytes and says committed_unverified, never a plain error', async (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.root, 'f.txt'), 'original');
  await assert.rejects(putFile(s.root, pf('new bytes', { mode: 'overwrite' }), { afterPublish: async () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); } }), committedUnverified('write_failed'));
  assert.equal(fs.readFileSync(path.join(s.root, 'f.txt'), 'utf8'), 'new bytes', 'the committed file is not rolled back');
  await assert.rejects(putFile(s.root, pf('created', { path: 'c.txt' }), { afterPublish: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } }), committedUnverified('write_failed'));
  assert.equal(fs.readFileSync(path.join(s.root, 'c.txt'), 'utf8'), 'created');
});

test('a failure before the publish leaves the original file and is not reported as committed', async (t) => {
  const s = scratch(t);
  fs.writeFileSync(path.join(s.root, 'f.txt'), 'original');
  await assert.rejects(putFile(s.root, pf('new bytes', { mode: 'overwrite' }), { beforeCommit: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } }), (e) => e.code === 'write_failed' && !(e.extra && e.extra.committed));
  assert.equal(fs.readFileSync(path.join(s.root, 'f.txt'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(s.root), ['f.txt'], 'no temp file left');
});

// ---------------- fixes after the independent review ----------------
test('concurrent overwrites of one file all succeed and each reports what it wrote (no spurious readback_mismatch)', async (t) => {
  const c = await setup(t);
  assert.equal((await put(c, body('seed', { path: 'one.txt' }))).status, 200);
  const sent = Array.from({ length: 30 }, (_, i) => 'v' + i + '-' + 'z'.repeat(40000));
  const rs = await Promise.all(sent.map((v) => put(c, body(v, { path: 'one.txt', mode: 'overwrite' }))));
  assert.deepEqual(rs.map((r) => r.status), sent.map(() => 200), JSON.stringify(rs.filter((r) => r.status !== 200).map((r) => r.json)));
  rs.forEach((r, i) => { assert.equal(r.json.sha256, sha(Buffer.from(sent[i]))); assert.equal(r.json.bytes, sent[i].length); });
  assert.ok(sent.includes(fs.readFileSync(path.join(inbox(c), 'one.txt'), 'utf8')));
  assert.deepEqual(ls(inbox(c)), ['one.txt']);
});

test('a path too long for this machine is refused with 400 before any directory is created', async (t) => {
  const c = await setup(t);
  const long = Array.from({ length: 4 }, (_, i) => String(i).repeat(240)).join('/') + '/f.txt'; // 970 characters, under the 1024 cap
  assert.ok(long.length < 1024);
  const r = await put(c, body('x', { path: long }));
  assert.equal(r.status, 400); assert.equal(r.json.error, 'path_invalid');
  assert.deepEqual(ls(inbox(c)), [], 'no directories were created');
});

test('an authenticated call refused before dispatch (too large, not JSON, not an object, not UTF-8) still gets its audit line; an unauthenticated one does not', async (t) => {
  const c = await setup(t);
  const auditFile = path.join(c.dir, 'logs', 'audit.jsonl');
  const count = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).length : 0);
  const cases = [
    [Buffer.from(JSON.stringify({ path: 'a.txt', content: 'z'.repeat(3 * 1024 * 1024), sha256: 'a'.repeat(64) })), 413, 'body_too_large'],
    [Buffer.from('{not json'), 400, 'bad_json'],
    [Buffer.from('['.repeat(1000000) + ']'.repeat(1000000)), 400, 'bad_json'],
    [Buffer.concat([Buffer.from('{"path":"a.txt","content":"'), Buffer.from([0xff]), Buffer.from('"}')]), 400, 'content_not_utf8'],
  ];
  for (const [b, status, code] of cases) {
    const before = count(); const r = await raw(c.port, b);
    assert.equal(r.status, status); assert.equal(r.json.error, code); assert.equal(count(), before + 1, code + ' is audited');
  }
  const rows = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.error_code), ['body_too_large', 'bad_json', 'bad_json', 'content_not_utf8']);
  assert.ok(rows.every((r) => r.result === 'rejected' && r.action === 'herdr.put_file' && r.path === null));
  const before = count();
  assert.equal((await raw(c.port, Buffer.from('{}'), { Authorization: 'Bearer ' + 'w'.repeat(43) })).status, 401);
  assert.equal(count(), before, 'unauthenticated attempts are not written to the audit log');
});

test('every failure on the put_file URL has the flat shape, including a refused Host header', async (t) => {
  const c = await setup(t);
  const r = await put(c, body('x'), { headers: { Host: 'evil.example.com' } });
  assert.equal(r.status, 421); assert.equal(r.json.ok, false); assert.equal(r.json.error, 'bad_host'); assert.equal(typeof r.json.detail, 'string');
});

test('a 30 MiB upload is answered with 413 and the client is never reset mid-upload', async (t) => {
  const c = await setup(t);
  const r = await raw(c.port, Buffer.alloc(30 * 1024 * 1024, 0x61));
  assert.equal(r.error, undefined); assert.equal(r.status, 413); assert.equal(r.json.error, 'body_too_large');
  assert.equal((await req(c.port, 'GET', '/api/health')).status, 200);
});

test('non-string content is invalid_param, and line separators and bidi controls never reach the audit log', async (t) => {
  const c = await setup(t);
  assert.equal((await put(c, { path: 'a.txt', content: 7, sha256: 'a'.repeat(64) })).json.error, 'invalid_param');
  assert.equal((await put(c, body('x', { path: 'a\u2028b\u202eevil\u2066' }))).status, 400);
  const last = JSON.parse(fs.readFileSync(path.join(c.dir, 'logs', 'audit.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(last.path_requested, 'a b evil ');
});

// exact permission bits, durability order and the no-follow opens: each of these is invisible under a normal umask, so they are exercised on purpose
test('the file is exactly 0600 and new directories exactly 0700 even under a restrictive umask', async (t) => {
  const s = scratch(t);
  const script = `process.umask(0o277); const { putFile } = require(${JSON.stringify(path.join(ROOT, 'lib', 'dropbox.js'))});
    const c = 'umask'; putFile(${JSON.stringify(s.root)}, { path: 'd1/d2/f.txt', content: c, sha256: require('crypto').createHash('sha256').update(c).digest('hex') })
      .then((r) => console.log(JSON.stringify(r)), (e) => { console.log(JSON.stringify({ err: e.code, detail: e.message })); });`;
  const out = await new Promise((resolve) => { let o = ''; const ch = spawn(process.execPath, ['-e', script]); ch.stdout.on('data', (d) => (o += d)); ch.on('exit', () => resolve(o)); });
  const r = JSON.parse(out); assert.equal(r.ok, true, out);
  assert.equal(mode(r.path), 0o600); assert.equal(mode(path.dirname(r.path)), 0o700); assert.equal(mode(path.dirname(path.dirname(r.path))), 0o700);
});

test('the temp file is fsynced before it is published, in both modes', async (t) => {
  const s = scratch(t); const events = [];
  const orig = { open: fsp().open, rename: fsp().rename, link: fsp().link };
  fsp().open = async (...a) => { const fh = await orig.open(...a); if (typeof a[1] === 'number' && (a[1] & fs.constants.O_CREAT)) { const sync = fh.sync.bind(fh); fh.sync = async () => { events.push('fsync'); return sync(); }; } return fh; };
  fsp().rename = async (...a) => { events.push('publish'); return orig.rename(...a); };
  fsp().link = async (...a) => { events.push('publish'); return orig.link(...a); };
  try {
    await putFile(s.root, pf('durable')); await putFile(s.root, pf('durable 2', { mode: 'overwrite' }));
  } finally { Object.assign(fsp(), orig); }
  assert.deepEqual(events, ['fsync', 'publish', 'fsync', 'publish']);
});
function fsp() { return fs.promises; }

test('the read-back refuses a file that was swapped for a symlink after the publish, and one that is not mode 0600', async (t) => {
  const s = scratch(t);
  const outside = path.join(s.d, 'outside.txt'); fs.writeFileSync(outside, 'not ours');
  await assert.rejects(putFile(s.root, pf('mine'), { afterPublish: async ({ final }) => { fs.rmSync(final); fs.symlinkSync(outside, final); } }), committedUnverified('symlink_refused'));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not ours');
  await assert.rejects(putFile(s.root, pf('mine', { path: 'g.txt' }), { beforeCommit: async ({ tmp }) => fs.chmodSync(tmp, 0o644) }), committedUnverified('readback_failed'));
});

test('the temp file is created exclusively: an existing file at the temp name is neither used nor removed', async (t) => {
  const s = scratch(t);
  const crypto2 = require('node:crypto'); const orig = crypto2.randomBytes;
  fs.writeFileSync(path.join(fs.realpathSync(s.root), '.put_file-0102030405060708.tmp'), 'precious');
  crypto2.randomBytes = () => Buffer.from('0102030405060708', 'hex');
  try { await assert.rejects(putFile(s.root, pf('x')), (e) => e.code === 'write_failed'); } finally { crypto2.randomBytes = orig; }
  assert.equal(fs.readFileSync(path.join(fs.realpathSync(s.root), '.put_file-0102030405060708.tmp'), 'utf8'), 'precious');
  assert.ok(!fs.existsSync(s.file));
});

test('a destination that is not a regular file (a FIFO) is refused', async (t) => {
  const s = scratch(t);
  execFileSync('mkfifo', [path.join(s.root, 'pipe')]);
  for (const m of ['create', 'overwrite']) await assert.rejects(putFile(s.root, pf('x', { path: 'pipe', mode: m })), (e) => e.code === 'not_regular_file' && e.status === 409);
  assert.ok(fs.statSync(path.join(s.root, 'pipe')).isFIFO());
});

test('the audit line of a committed but unverified write says so, with the path and hash of the bytes written', () => {
  const { ACTIONS } = require('../lib/actions');
  const { ApiError } = require('../lib/validate');
  const err = Object.assign(new ApiError(500, 'committed_unverified', 'x', { committed: true }), { info: { path: '/d/f.txt', bytes: 3, sha256: 'a'.repeat(64) } });
  const line = ACTIONS['herdr.put_file'].audit({}, { path: 'f.txt', mode: 'overwrite' }, null, err);
  assert.equal(line.result, 'committed_unverified'); assert.equal(line.error_code, 'committed_unverified');
  assert.equal(line.path, '/d/f.txt'); assert.equal(line.sha256, 'a'.repeat(64)); assert.equal(line.http_status, 500);
});

// ---------------- ledger intent/outcome and the owed audit line (dispatch and HTTP in this process) ----------------
// Fresh lib modules bound to a scratch drop root; ledger and audit files are explicit. boot() is what server.js does
// at start: open both, then write the owed audit lines from the ledger.
function inproc(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-p4-')); const drop = path.join(d, 'inbox'); fs.mkdirSync(drop, { mode: 0o700 });
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const prev = process.env.HERDR_PORTAL_DROP_DIR; process.env.HERDR_PORTAL_DROP_DIR = drop;
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'lib') + path.sep)) delete require.cache[k];
  try {
    const { dispatch, reconciledAudit } = require('../lib/actions');
    const { Ledger } = require('../lib/ledger'); const { Audit } = require('../lib/audit'); const { createServer } = require('../lib/server');
    const files = { ledger: path.join(d, 'ledger.jsonl'), audit: path.join(d, 'audit.jsonl') };
    const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const boot = () => { const ledger = new Ledger(files.ledger); const audit = new Audit(files.audit); ledger.reconcile((row) => audit.append(reconciledAudit(row))); return { ledger, audit }; };
    return { d, drop: fs.realpathSync(drop), files, dispatch, boot, Ledger, createServer, ledgerRows: () => lines(files.ledger), auditRows: () => lines(files.audit) };
  } finally { if (prev === undefined) delete process.env.HERDR_PORTAL_DROP_DIR; else process.env.HERDR_PORTAL_DROP_DIR = prev; }
}
const failingAudit = () => ({ healthy: true, append() { throw new Error('EIO'); } });

test('put_file: an intent row is durable before the first change, the outcome after, and the audit line is acknowledged', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  const b = await s.dispatch(ctx, 'herdr.put_file', 'POST', body('zq-content-marker', { path: 'sub/a.txt' }));
  assert.equal(b.ok, true); assert.match(b.intent_id, /^[0-9a-f-]{36}$/);
  const rows = s.ledgerRows();
  assert.deepEqual(rows.map((r) => [r.t, r.kind || null, r.status || null]), [['pending', 'file', null], ['done', 'file', 'written'], ['audited', null, null]]);
  assert.ok(rows.every((r) => r.intent_id === b.intent_id)); assert.equal(rows[0].audit, 'owed');
  assert.ok(!fs.readFileSync(s.files.ledger, 'utf8').includes('zq-content-marker'), 'no content in the ledger');
  const audit = s.auditRows(); assert.equal(audit.length, 1); assert.equal(audit[0].intent_id, b.intent_id); assert.equal(audit[0].result, 'written');
  s.boot(); assert.equal(s.auditRows().length, 1, 'an acknowledged outcome is not audited again');
});

test('put_file: the ledger cannot record the intent -> 503 ledger_unavailable and nothing is created', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  ctx.ledger.begin = () => { throw new Error('ENOSPC'); };
  await assert.rejects(s.dispatch(ctx, 'herdr.put_file', 'POST', body('x', { path: 'new/dir/a.txt' })), (e) => e.status === 503 && e.code === 'ledger_unavailable');
  assert.deepEqual(ls(s.drop), [], 'not even the directory');
  assert.equal(s.auditRows()[0].result, 'rejected');
});

test('put_file: an outcome that cannot be recorded after the publish is committed_unverified ledger_unrecorded, never a clean 200', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  ctx.ledger.finish = () => { throw new Error('EIO'); };
  await assert.rejects(s.dispatch(ctx, 'herdr.put_file', 'POST', body('kept')), (e) => e.status === 500 && e.code === 'committed_unverified'
    && e.extra.reason === 'ledger_unrecorded' && e.extra.committed === true && e.extra.verified === false && e.extra.retryable === false && /^[0-9a-f-]{36}$/.test(e.extra.intent_id)
    && e.extra.observed_sha256 === sha(Buffer.from('kept')) && e.extra.observed_bytes === 4);
  assert.equal(fs.readFileSync(path.join(s.drop, 'a.txt'), 'utf8'), 'kept');
  const after = s.boot().ledger.recovered;
  assert.equal(after.length, 1, 'the intent without an outcome is recovered at the next boot');
  assert.deepEqual([after[0].status, after[0].finished_at, typeof after[0].recovered_at, after[0].detail.observed.exists], ['needs_review', null, 'string', true]);
});

test('put_file: an audit failure after a durable outcome answers audit "deferred"; the next boot writes it once, a second boot not again', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  ctx.audit = failingAudit();
  const b = await s.dispatch(ctx, 'herdr.put_file', 'POST', body('later'));
  assert.equal(b.ok, true); assert.equal(b.audit, 'deferred');
  assert.equal(s.ledgerRows().filter((r) => r.t === 'audited').length, 0);
  s.boot();
  const a = s.auditRows(); assert.equal(a.length, 1);
  assert.deepEqual([a[0].intent_id, a[0].result, a[0].reconciled, a[0].sha256], [b.intent_id, 'written', true, b.sha256]);
  s.boot(); assert.equal(s.auditRows().length, 1);
});

test('crash windows: intent only -> needs_review with recovered_at and finished_at null, file untouched; audit-before-ack -> a duplicate line', async (t) => {
  const s = inproc(t);
  const file = path.join(s.drop, 'keep.txt'); fs.writeFileSync(file, 'original', { mode: 0o600 });
  const before = fs.statSync(file);
  const l = new s.Ledger(s.files.ledger);
  l.begin({ kind: 'file', intent_id: '11111111-1111-4111-8111-111111111111', audit: 'owed', action: 'herdr.put_file', path: file, mode: 'overwrite', bytes: 3, sha256: 'a'.repeat(64), started_at: '2026-10-16T00:00:00.000Z' });
  // crash after the audit line but before its ack: an outcome row whose audit line exists
  l.finish({ kind: 'file', intent_id: '22222222-2222-4222-8222-222222222222', audit: 'owed', action: 'herdr.put_file', path: file, mode: 'overwrite', bytes: 8, sha256: 'b'.repeat(64), started_at: '2026-10-16T00:00:00.000Z', finished_at: '2026-10-16T00:00:01.000Z', status: 'written' });
  fs.writeFileSync(s.files.audit, JSON.stringify({ action: 'herdr.put_file', result: 'written', intent_id: '22222222-2222-4222-8222-222222222222' }) + '\n', { mode: 0o600 });
  const { ledger } = s.boot();
  const rec = ledger.recovered[0];
  assert.deepEqual([rec.status, rec.finished_at, typeof rec.recovered_at, rec.detail.observed], ['needs_review', null, 'string', { exists: true, regular_file: true, bytes: 8 }]);
  const after = fs.statSync(file);
  assert.deepEqual([after.ino, after.mtimeMs, fs.readFileSync(file, 'utf8')], [before.ino, before.mtimeMs, 'original'], 'recovery never writes the file');
  const a = s.auditRows();
  assert.deepEqual(a.map((e) => [e.intent_id.slice(0, 1), e.result]).sort(), [['1', 'needs_review'], ['2', 'written'], ['2', 'written']], 'at least once: the un-acked line is written again');
  s.boot(); assert.equal(s.auditRows().length, 3);
});

test('legacy ledger rows (no audit field) are never reconciled into the audit log', async (t) => {
  const s = inproc(t);
  const legacy = { t: 'done', request_id: 'req-old-00000001', idempotency_key: 'idem-old-000000000001', payload_hash: 'h', action: 'herdr.pane_send_text', session: 'default', target: { pane_id: 'w1:p1' }, started_at: '2026-10-01T00:00:00.000Z', finished_at: '2026-10-01T00:00:01.000Z', status: 'input_sent', detail: {} };
  fs.writeFileSync(s.files.ledger, JSON.stringify(legacy) + '\n', { mode: 0o600 });
  const { ledger } = s.boot();
  assert.deepEqual(s.auditRows(), []);
  assert.equal(ledger.lookup(legacy.idempotency_key).record.finished_at, legacy.finished_at);
  assert.equal(fs.readFileSync(s.files.ledger, 'utf8'), JSON.stringify(legacy) + '\n', 'history is not rewritten');
});

test('committed_unverified over dispatch and HTTP: body, ledger and audit agree on the intent; sha256 is requested, observed_sha256 is on disk', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  ctx.dropHooks = { afterPublish: ({ final }) => fs.writeFileSync(final, 'something else entirely') };
  const server = s.createServer({ ctx, tokenDigest: crypto.createHash('sha256').update(TOKEN).digest(), log: () => {}, tunnelProbe: async () => ({ up: false }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => server.close(r)));
  const r = await req(server.address().port, 'POST', '/api/herdr/put_file', { body: body('requested') });
  assert.equal(r.status, 500, JSON.stringify(r.json));
  const want = sha(Buffer.from('requested')); const disk = sha(Buffer.from('something else entirely'));
  assert.deepEqual([r.json.error, r.json.reason, r.json.committed, r.json.verified, r.json.retryable, r.json.sha256, r.json.bytes, r.json.observed_sha256, r.json.observed_bytes],
    ['committed_unverified', 'readback_mismatch', true, false, false, want, 9, disk, 23]);
  const done = s.ledgerRows().find((x) => x.t === 'done');
  const a = s.auditRows().at(-1);
  assert.deepEqual([done.status, done.intent_id, a.result, a.intent_id, a.sha256, a.observed_sha256], ['committed_unverified', r.json.intent_id, 'committed_unverified', r.json.intent_id, want, disk]);
  assert.ok(s.ledgerRows().some((x) => x.t === 'audited' && x.intent_id === r.json.intent_id));
  ctx.audit = failingAudit();
  const r2 = await req(server.address().port, 'POST', '/api/herdr/put_file', { body: body('requested', { path: 'b.txt' }) });
  assert.deepEqual([r2.status, r2.json.error, r2.json.audit], [500, 'committed_unverified', 'deferred']);
});

test('put_file keeps working while Herdr is down', async (t) => {
  const c = await setup(t);
  await c.herdr.close();
  const r = await put(c, body('no herdr needed', { path: 'down.txt' }));
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.bytes, 15);
});

test('a rejection after the intent tells the caller audit "deferred" and its intent_id, and nothing else from the error internals', async (t) => {
  const s = inproc(t); const ctx = s.boot();
  ctx.dropHooks = { beforeCommit: () => { const e = new Error('disk'); e.code = 'EIO'; throw e; } };
  const server = s.createServer({ ctx, tokenDigest: crypto.createHash('sha256').update(TOKEN).digest(), log: () => {}, tunnelProbe: async () => ({ up: false }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => server.close(r)));
  ctx.audit = failingAudit();
  const r = await req(server.address().port, 'POST', '/api/herdr/put_file', { body: body('never published') });
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.deepEqual(Object.keys(r.json).sort(), ['audit', 'detail', 'error', 'intent_id', 'ok']);
  assert.deepEqual([r.json.error, r.json.audit], ['write_failed', 'deferred']); assert.match(r.json.intent_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(ls(s.drop), [], 'nothing was published');
});
