'use strict';
// Append-only audit log of every manage (write) action, one JSON line per request, fsync'd. Lives under the
// logs directory so it can be read without touching the replay ledger. It never stores prompt or command text.
const fs = require('fs');

class Audit {
  constructor(file) {
    this.file = file;
    this.healthy = true;
    this.fd = fs.openSync(file, 'a', 0o600);
    const size = fs.fstatSync(this.fd).size;
    if (size > 0) { // a torn last line must not swallow the next entry
      const rfd = fs.openSync(file, 'r'); const tail = Buffer.alloc(1);
      try { fs.readSync(rfd, tail, 0, 1, size - 1); } finally { fs.closeSync(rfd); }
      if (tail[0] !== 0x0a) fs.writeSync(this.fd, '\n');
    }
    fs.chmodSync(file, 0o600);
  }

  append(entry) {
    try {
      fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(this.fd);
    } catch (e) { this.healthy = false; throw e; }
  }

  // Last `n` entries, oldest first. Reads only the end of the file; bytes are joined before decoding so a multibyte
  // character split at a chunk boundary survives.
  tail(n) {
    const size = fs.fstatSync(this.fd).size;
    const chunk = 256 * 1024;
    const rfd = fs.openSync(this.file, 'r');
    const parts = []; let newlines = 0;
    try {
      let pos = size;
      while (pos > 0 && newlines <= n) {
        const len = Math.min(chunk, pos); pos -= len;
        const buf = Buffer.alloc(len); fs.readSync(rfd, buf, 0, len, pos);
        parts.unshift(buf);
        for (const b of buf) if (b === 0x0a) newlines += 1;
      }
    } finally { fs.closeSync(rfd); }
    const out = [];
    for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial first line of the window or torn line */ }
    }
    return { entries: out.slice(-n), total_bytes: size };
  }
}

module.exports = { Audit };
