'use strict';
// The documentation promises things a reader will check: links that resolve and numbers that match the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIONS } = require('../lib/actions');
const { PINNED_HERDR_VERSION } = require('../lib/config');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.scratch', 'official', '.git']);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function markdown(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdown(p, out); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
function headings(file) {
  const out = new Set(); let fence = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[1].replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')));
  }
  return out;
}

test('every relative link and #anchor in the Markdown files resolves', () => {
  const broken = [];
  for (const file of markdown()) {
    let fence = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?|mailto):/.test(target)) continue;
        const [rel, frag] = target.split('#');
        const dest = rel ? path.resolve(path.dirname(file), rel) : file;
        if (!fs.existsSync(dest)) broken.push(`${path.relative(ROOT, file)} -> ${target} (no such file)`);
        else if (frag && dest.endsWith('.md') && !headings(dest).has(frag)) broken.push(`${path.relative(ROOT, file)} -> ${target} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('every repository path a document names exists', () => {
  const missing = [];
  for (const file of markdown()) {
    // A path followed by more path characters or a wildcard (docs/e2e-*.json) is a pattern, not a file.
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?<![\w./-])((?:tests|scripts|bin|lib|docs|plugin|public)\/[\w./-]*\w)(?![\w-]|\.\w|\/|\*)/g)) {
      if (m[1].startsWith('docs/official/')) continue; // fetched on demand and git-ignored (scripts/fetch-herdr-docs.js)
      const found = [ROOT, path.dirname(file)].some((base) => fs.existsSync(path.join(base, m[1])));
      if (!found) missing.push(`${path.relative(ROOT, file)} names ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every document states the real number of actions, and the README states one', () => {
  const n = Object.keys(ACTIONS).length;
  const stated = [];
  for (const file of markdown()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b(\d+)[ -](?:allowed )?actions?\b/g)) stated.push({ file: path.relative(ROOT, file), n: Number(m[1]) });
  }
  assert.ok(stated.some((s) => s.file === 'README.md'), 'the README says how many actions there are');
  assert.deepEqual(stated.filter((s) => s.n !== n), []);
});

test('every document states the number of Herdr request methods that the proof matrix recorded', () => {
  const recorded = Number(/\*\*(\d+)\*\* request methods/.exec(read('docs', 'proof-matrix.md'))[1]);
  const stated = [];
  for (const file of markdown()) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/\b(\d+)\*{0,2} request methods\b/g)) stated.push({ file: path.relative(ROOT, file), n: Number(m[1]) });
  }
  assert.ok(stated.some((s) => s.file === 'README.md'), 'the README says how many request methods Herdr has');
  assert.deepEqual(stated.filter((s) => s.n !== recorded), []);
});

test('no document states a count of tests: a hand-kept number goes stale and cannot be checked without running the suite', () => {
  for (const f of markdown()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /\b\d{2,5} tests\b/, `${path.relative(ROOT, f)} states a test count`);
  }
});

test('the documents that name the Herdr version proven live name the pinned one', () => {
  for (const file of ['README.md', 'docs/configuration.md', 'docs/control.md']) {
    const text = read(...file.split('/')).replace(/\b\d+\.\d+\.\d+\.\d+\b/g, ''); // addresses such as 127.0.0.1 are not versions
    const versions = [...new Set(text.match(/\b0\.\d+\.\d+\b/g) || [])];
    assert.deepEqual(versions.filter((v) => v !== PINNED_HERDR_VERSION), [], `${file} names a Herdr version other than ${PINNED_HERDR_VERSION}`);
  }
});
