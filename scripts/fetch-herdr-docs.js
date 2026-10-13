#!/usr/bin/env node
'use strict';
// Downloads the three Herdr documentation pages that docs/proof-matrix.md is checked against, at the Herdr version the
// version you name (default: the version proven live), into docs/official/ (git-ignored: the pages are Herdr's, not part of this repository).
//   node scripts/fetch-herdr-docs.js [--version 0.9.4]
// The index https://herdr.dev/llms.txt lists these raw sources per release. If your network inspects TLS, Node may need
// NODE_USE_SYSTEM_CA=1 to trust the proxy's certificate.
const fs = require('fs');
const path = require('path');
const { PINNED_HERDR_VERSION } = require('../lib/config');

const vi = process.argv.indexOf('--version');
const VERSION = vi > 0 ? String(process.argv[vi + 1] || '').replace(/^v/, '') : PINNED_HERDR_VERSION;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) { console.error('--version needs a release like 0.9.4'); process.exit(2); }
const BASE = `https://raw.githubusercontent.com/herdrdev/herdr/v${VERSION}/docs/next/website/src/content/docs`;
const PAGES = ['cli-reference', 'socket-api', 'agent-automation'];
const OUT = path.join(__dirname, '..', 'docs', 'official');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of PAGES) {
    const url = `${BASE}/${name}.mdx`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const body = await res.text();
    if (!body.includes('\n## ')) throw new Error(`${url} does not look like a documentation page`);
    fs.writeFileSync(path.join(OUT, `${name}.mdx`), body);
    fs.writeFileSync(path.join(OUT, 'VERSION'), VERSION + '\n');
    console.log(`saved docs/official/${name}.mdx (${body.length} bytes) from ${url}`);
  }
})().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
