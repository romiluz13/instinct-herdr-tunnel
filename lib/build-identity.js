'use strict';
// Identity of the running build: which server code it loaded, which static bytes it serves, and which process
// instance answered. Hashes, a random id and a start time only; no paths.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// server.js plus every module in lib/, enumerated, so a module added or changed later is covered too.
function codeFiles(root) {
  return ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).sort().map((f) => 'lib/' + f)];
}

function codeDigest(root = path.join(__dirname, '..')) {
  const h = crypto.createHash('sha256');
  for (const f of codeFiles(root)) h.update(f + '\0').update(fs.readFileSync(path.join(root, f))).update('\0');
  return h.digest('hex');
}

// Over the exact buffers the server keeps in memory and serves, keyed by file name.
function staticDigest(buffers) {
  const h = crypto.createHash('sha256');
  for (const name of [...buffers.keys()].sort()) h.update(name + '\0').update(buffers.get(name)).update('\0');
  return h.digest('hex');
}

const instance = { instance_id: crypto.randomBytes(16).toString('hex'), started_at: new Date().toISOString() };

module.exports = { codeDigest, codeFiles, staticDigest, instance };
