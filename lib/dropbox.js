'use strict';
// put_file: write one UTF-8 text file under the drop root, atomically, and report what is on disk afterwards.
// Never touches Herdr, never runs or interprets the content. All filesystem calls are asynchronous (libuv thread
// pool), so a slow disk or a busy Herdr cannot stall other requests on the event loop.
//
// Documentation each primitive relies on:
//   O_NOFOLLOW  "If path names a symbolic link, fail and set errno to [ELOOP]."
//               https://pubs.opengroup.org/onlinepubs/9699919799/functions/open.html (O_NOFOLLOW, ERRORS)
//               Node: "Flag indicating that the open should fail if the path is a symbolic link."
//               https://nodejs.org/docs/latest-v22.x/api/fs.html#file-open-constants (O_NOFOLLOW)
//   O_CREAT|O_EXCL  "open() shall fail if the file exists", and it fails with [EEXIST] on a symlink: same open(3p) page, O_EXCL.
//   rename      "If the link named by the new argument exists, it shall be removed and old renamed to new" and
//               "any file named by new shall be unaffected" on failure; the action "be atomic".
//               https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html (DESCRIPTION, RETURN VALUE)
//   link        "shall atomically create a new link for the existing file"; [EEXIST] when path2 already exists.
//               https://pubs.opengroup.org/onlinepubs/9699919799/functions/link.html. Used for mode "create", so two racing
//               creates cannot both win and an existing file is never replaced (needs a filesystem with hard links).
//   fsync       filehandle.sync(): "Request that all data for the open file descriptor is flushed to the storage device."
//               https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlesync (this does not fsync the directory)
//   isWellFormed  "returns a boolean indicating whether this string contains any lone surrogates."
//               https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/isWellFormed
//   realpath    "Determines the actual location of path using the same semantics as the fs.realpath.native() function."
//               https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrealpathpath-options
//   lstat       "...unless path refers to a symbolic link, in which case the link itself is stat-ed"
//               https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseslstatpath-options
// Limits of this check: a local process that can already write inside the drop root (mode 0700, owner only) could swap a
// directory for a symlink between our lstat and our open. The remote caller cannot; the final realpath check bounds the damage.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ApiError } = require('./validate');

const MAX_CONTENT_BYTES = 262144;
const MAX_PATH_CHARS = 1024;
const PATH_MAX = 1024; // macOS; Linux allows more, so this is the safe minimum
const TMP_NAME_LEN = '.put_file-'.length + 16 + '.tmp'.length;
const MAX_DEPTH = 16;
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/; // no leading dot: names we create (.put_file-*.tmp) can never collide with a caller's
const HEX64 = /^[0-9a-fA-F]{64}$/;
const { O_WRONLY, O_RDONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;

const fail = (status, code, detail, info) => Object.assign(new ApiError(status, code, detail), { info });
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);

// One put_file at a time per destination, in this process (the portal is one process). Without it two overwrites of one
// name race: the later rename can replace the file between the earlier call's publish and its read-back, and that call
// would report a mismatch for a write that succeeded. Lower-cased because the default macOS volume is case-insensitive.
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release; const gate = new Promise((r) => { release = r; });
  const tail = prev.then(() => gate);
  locks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}

// Components of `raw` below the root; throws for anything that is not a plain relative or in-root absolute path.
function components(raw, roots, info) {
  if (typeof raw !== 'string' || raw.length === 0) throw fail(400, 'path_invalid', 'path is empty', info);
  if (raw.length > MAX_PATH_CHARS) throw fail(400, 'path_invalid', `path is longer than ${MAX_PATH_CHARS} characters`, info);
  if (raw.includes('\0')) throw fail(400, 'path_invalid', 'path contains a NUL byte', info);
  let rel = raw;
  if (raw.startsWith('/')) {
    const base = roots.find((r) => raw.startsWith(r + '/'));
    if (!base) throw fail(403, 'path_outside_root', 'absolute path is not inside the drop root', info);
    rel = raw.slice(base.length + 1);
  }
  const parts = rel.split('/');
  if (parts.length > MAX_DEPTH) throw fail(400, 'path_invalid', `path is deeper than ${MAX_DEPTH} levels`, info);
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw fail(400, 'path_invalid', 'path has an empty, "." or ".." component', info);
    if (!NAME_RE.test(part)) throw fail(400, 'path_invalid', 'path components may use only A-Z a-z 0-9 . _ - and may not start with a dot', info);
  }
  return parts;
}

async function ensureDir(dir) { // created by us with 0700; an existing entry must be a real directory
  try { await fsp.mkdir(dir, { mode: 0o700 }); await fsp.chmod(dir, 0o700); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = await fsp.lstat(dir);
  if (st.isSymbolicLink()) throw fail(403, 'symlink_refused', 'a path component is a symbolic link');
  if (!st.isDirectory()) throw fail(409, 'not_a_directory', 'a path component exists and is not a directory');
}

// `p`: { path, content, sha256, mode }. Test hooks: `afterChecks` runs once every path check has passed, `beforeCommit` after
// the temp file is durable and before it is published, `afterPublish` before the read-back; tests use them to swap a
// directory or the file for a symlink, or to fail or kill the writer at exactly those points.
async function putFile(dropDir, p, hooks = {}, intent = () => {}) {
  const info = { path: null, bytes: null, sha256: null };
  const mode = p.mode || 'create';

  // 1. Everything that needs no filesystem: the destination is not touched until all of it passed.
  const configured = path.resolve(dropDir);
  const parts = components(p.path, [configured, ...(await fsp.realpath(configured).then((r) => [r], () => []))], info);
  if (typeof p.content !== 'string') throw fail(400, 'invalid_param', 'content must be a string', info);
  if (!p.content.isWellFormed()) throw fail(400, 'content_not_utf8', 'content is not valid UTF-8 (lone surrogate)', info);
  const buf = Buffer.from(p.content, 'utf8');
  info.bytes = buf.length;
  if (buf.length > MAX_CONTENT_BYTES) throw fail(413, 'content_too_large', `content is ${buf.length} bytes; the limit is ${MAX_CONTENT_BYTES}`, info);
  if (typeof p.sha256 !== 'string' || !HEX64.test(p.sha256)) throw fail(400, 'sha256_invalid', 'sha256 must be 64 hex characters', info);
  const want = sha256hex(buf);
  info.sha256 = want;
  if (want !== p.sha256.toLowerCase()) throw fail(422, 'sha256_mismatch', `sha256 of the received content is ${want}; nothing was written`, info);

  // 2. The root, then each existing component, with lstat (a symlink is never followed).
  let root;
  try { root = await fsp.realpath(configured); } catch { throw fail(503, 'drop_root_missing', 'the drop root does not exist', info); }
  const rst = await fsp.stat(root);
  if (!rst.isDirectory() || rst.uid !== process.getuid() || (rst.mode & 0o022) !== 0) throw fail(503, 'drop_root_unsafe', 'the drop root must be a directory owned by the portal user and not writable by others', info);
  if (root.length + 1 + parts.join('/').length + 1 + TMP_NAME_LEN >= PATH_MAX) throw fail(400, 'path_invalid', `path is too long: with the drop root and the temp name it would reach ${PATH_MAX} bytes`, info);
  return withLock(path.join(root, ...parts).toLowerCase(), () => write(root, parts, mode, buf, want, info, hooks, intent));
}

async function write(root, parts, mode, buf, want, info, hooks, intent) {
  const name = parts[parts.length - 1];
  let dir = root; const missing = [];
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    if (missing.length) { missing.push(dir); continue; }
    let st;
    try { st = await fsp.lstat(dir); } catch (e) { if (e.code === 'ENOENT') { missing.push(dir); continue; } throw e; }
    if (st.isSymbolicLink()) throw fail(403, 'symlink_refused', 'a path component is a symbolic link', info);
    if (!st.isDirectory()) throw fail(409, 'not_a_directory', 'a path component exists and is not a directory', info);
  }
  const target = path.join(dir, name);
  info.path = target;
  if (!missing.length) {
    let st = null;
    try { st = await fsp.lstat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st) {
      if (st.isSymbolicLink()) throw fail(403, 'symlink_refused', 'the target is a symbolic link', info);
      if (st.isDirectory()) throw fail(409, 'is_directory', 'the target is a directory', info);
      if (!st.isFile()) throw fail(409, 'not_regular_file', 'the target exists and is not a regular file', info);
      if (mode === 'create') throw fail(409, 'exists', 'the file exists; use mode "overwrite" to replace it', info);
    }
  }

  // 3. Write: temp file in the same directory (exclusive, 0600, no symlink), fsync, then publish. The caller's intent
  // record is durable before the first change on disk (a directory or the temp file); if it cannot be, nothing changes.
  intent(info);
  let committed = false; // true once rename/link succeeded: from then on the new bytes are under the requested name
  let observed = {}; // what the read-back found, when it got that far
  try {
    for (const d of missing) await ensureDir(d);
    if (hooks.afterChecks) await hooks.afterChecks({ dir });
    const parentReal = await fsp.realpath(dir);
    if (!inside(root, parentReal)) throw fail(403, 'symlink_refused', 'the directory resolves outside the drop root', info);
    const final = path.join(parentReal, name);
    const tmp = path.join(parentReal, `.put_file-${crypto.randomBytes(8).toString('hex')}.tmp`);
    let fh = null; let made = false;
    try {
      fh = await fsp.open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
      made = true;
      await fh.chmod(0o600); // the creation mode is reduced by the umask, never raised; this makes it exact
      await fh.writeFile(buf);
      await fh.sync();
      await fh.close(); fh = null;
      if (hooks.beforeCommit) await hooks.beforeCommit({ tmp, final });
      if (mode === 'overwrite') await fsp.rename(tmp, final);
      else {
        try { await fsp.link(tmp, final); } catch (e) { if (e.code === 'EEXIST') throw fail(409, 'exists', 'the file exists; use mode "overwrite" to replace it', info); throw e; }
      }
      committed = true;
    } finally {
      if (fh) await fh.close().catch(() => {});
      if (made) await fsp.unlink(tmp).catch(() => {}); // only a file this call created; after rename it is already gone; after link it is the second name of the published file
    }

    if (hooks.afterPublish) await hooks.afterPublish({ final });

    // 4. What the caller is told comes from the disk, not from the request.
    const rfh = await fsp.open(final, O_RDONLY | O_NOFOLLOW);
    let onDisk; let st;
    try { st = await rfh.stat(); onDisk = await rfh.readFile(); } finally { await rfh.close(); }
    const real = await fsp.realpath(final);
    if (!inside(root, real)) throw fail(500, 'readback_failed', 'the written file resolves outside the drop root', info);
    const got = sha256hex(onDisk);
    observed = { observed_sha256: got, observed_bytes: onDisk.length };
    info.path = real; info.sha256 = got;
    if (!st.isFile() || onDisk.length !== buf.length || got !== want) throw fail(500, 'readback_mismatch', 'the file on disk does not match what was received', info);
    if ((st.mode & 0o7777) !== 0o600) throw fail(500, 'readback_failed', 'the file on disk does not have mode 0600', info);
    return { ok: true, path: real, bytes: onDisk.length, sha256: got, mode_used: mode };
  } catch (e) {
    let err = e;
    if (!(err instanceof ApiError)) err = err.code === 'ELOOP' ? fail(403, 'symlink_refused', 'a path component is a symbolic link', info) : fail(500, 'write_failed', `could not write the file (${err.code || 'error'})`, info);
    if (!err.info) err.info = info;
    if (!committed) throw err;
    // The publish happened, so the file now holds this call's bytes and is left as it is. Retrying would write it again;
    // the caller must inspect the file. sha256/bytes are what this call received and wrote; observed_* (only when the
    // read-back got that far) are what it then found on disk.
    const cu = new ApiError(500, 'committed_unverified', `the file was written but could not be verified (${err.code}); inspect it before retrying`, { committed: true, verified: false, retryable: false, reason: err.code, path: info.path, sha256: want, bytes: buf.length, ...observed });
    throw Object.assign(cu, { info: { ...info, sha256: want, bytes: buf.length } });
  }
}

module.exports = { putFile, MAX_CONTENT_BYTES };
