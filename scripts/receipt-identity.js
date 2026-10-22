'use strict';
// Identity of the code and Herdr build a proof receipt (smoke/e2e/decision-proof output) was produced against.
// gen-proof-matrix.js treats a receipt as current evidence only when this identity matches the present one;
// anything else is reported as "untested". The identity holds hashes and versions, never paths or addresses.
// source_sha256 is the checkout that ran the script; served_code_sha256 is what the answering server reported in
// /api/health build. A receipt counts only when both match the current source, so a server still running older
// code cannot vouch for a newer checkout.
const path = require('path');
const { codeDigest, codeFiles } = require('../lib/build-identity');

const sourceDigest = (root = path.join(__dirname, '..')) => codeDigest(root);

const make = ({ herdrVersion, protocol, served }, root) => ({ source_sha256: sourceDigest(root), served_code_sha256: (served && served.code_sha256) || null, served_instance_id: (served && served.instance_id) || null, herdr_version: herdrVersion || null, protocol: protocol == null ? null : Number(protocol) });
const same = (a, b) => !!a && !!b && !!a.source_sha256 && a.source_sha256 === b.source_sha256 && a.served_code_sha256 === a.source_sha256 && !!a.herdr_version && a.herdr_version === b.herdr_version && a.protocol != null && a.protocol === b.protocol;
// Only a calendar date reaches generated public documents.
const dateOnly = (at) => (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null);

module.exports = { make, same, sourceDigest, dateOnly, codeFiles };
