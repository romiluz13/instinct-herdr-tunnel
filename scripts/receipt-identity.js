'use strict';
// Identity of the code and Herdr build a proof receipt (smoke/e2e/decision-proof output) was produced against.
// gen-proof-matrix.js treats a receipt as current evidence only when this identity matches the present one;
// anything else is reported as "untested". The identity holds hashes and versions, never paths or addresses.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILES = ['lib/actions.js', 'lib/dialog.js', 'lib/validate.js', 'lib/herdr.js'];

function sourceDigest(root = path.join(__dirname, '..')) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) h.update(f + '\0').update(fs.readFileSync(path.join(root, f))).update('\0');
  return h.digest('hex');
}

const make = ({ herdrVersion, protocol }, root) => ({ source_sha256: sourceDigest(root), herdr_version: herdrVersion || null, protocol: protocol == null ? null : Number(protocol) });
const same = (a, b) => !!a && !!b && !!a.source_sha256 && a.source_sha256 === b.source_sha256 && !!a.herdr_version && a.herdr_version === b.herdr_version && a.protocol != null && a.protocol === b.protocol;
// Only a calendar date reaches generated public documents.
const dateOnly = (at) => (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null);

module.exports = { make, same, sourceDigest, dateOnly, FILES };
