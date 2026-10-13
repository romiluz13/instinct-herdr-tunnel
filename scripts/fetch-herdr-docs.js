#!/usr/bin/env node
'use strict';
// Downloads the three Herdr documentation pages that docs/proof-matrix.md is checked against, at the Herdr version the
// portal is pinned to, into docs/official/ (git-ignored: the pages are Herdr's, not part of this repository).
//   node scripts/fetch-herdr-docs.js
// The index https://herdr.dev/llms.txt lists these raw sources per release. If your network inspects TLS, Node may need
// NODE_USE_SYSTEM_CA=1 to trust the proxy's certificate.
const fs = require('fs');
const path = require('path');
const { PINNED_HERDR_VERSION } = require('../lib/config');

const BASE = `https://raw.githubusercontent.com/herdrdev/herdr/v${PINNED_HERDR_VERSION}/docs/next/website/src/content/docs`;
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
    console.log(`saved docs/official/${name}.mdx (${body.length} bytes) from ${url}`);
  }
})().catch((e) => { console.error('fetch failed:', e.message); process.exit(1); });
