'use strict';
// The real size of a pane's terminal, which no Herdr method reports: pane.layout rects include the borders, and
// PaneScrollInfo gives only the row count. The pane's tty does know it. The pid comes from pane.process_info, the tty
// from the same result (when Herdr fills it) or from ps, the size from stty. Both tools run by absolute path with an
// argument array, so neither PATH nor a shell is involved.
const { execFile } = require('child_process');
const fs = require('fs');
const herdr = require('./herdr');
const { ApiError } = require('./validate');
const { config } = require('./config');

const unverified = (why) => new ApiError(409, 'size_unverified', `cannot confirm the real size of this pane's terminal (${why}); nothing was sent`);

const firstExisting = (paths) => paths.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
// Resolved once at start-up from a fixed list; HERDR_PORTAL_PS_BIN / HERDR_PORTAL_STTY_BIN override them (the tests use that).
const PS = config.psBin || firstExisting(['/bin/ps', '/usr/bin/ps']);
const STTY = config.sttyBin || firstExisting(['/bin/stty', '/usr/bin/stty']);
const STTY_DEVICE_FLAG = process.platform === 'darwin' ? '-f' : '-F'; // BSD stty opens the device with -f, GNU stty with -F

function run(bin, args) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('tool not found'));
    execFile(bin, args, { env: { PATH: '/usr/bin:/bin' }, timeout: config.sizeToolTimeoutMs, maxBuffer: 4096, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}

const TTY = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,39}$/;
const normalizeTty = (t) => {
  const name = String(t || '').trim().replace(/^\/dev\//, '');
  return TTY.test(name) && !name.includes('..') ? name : null; // ps prints ?? or ? for a process without a terminal
};

const why = (e) => (e && e.killed ? 'timed out' : e && e.code !== undefined ? (typeof e.code === 'number' ? 'exit ' + e.code : String(e.code)) : 'error');

async function ttyOfPid(pid) {
  return normalizeTty(await run(PS, ['-o', 'tty=', '-p', String(pid)]));
}

async function readPaneSize(sock, paneId) {
  let info;
  try { info = (await herdr.call(sock, 'pane.process_info', { pane_id: paneId })).process_info || {}; }
  catch { throw unverified('pane.process_info failed'); }
  const shellPid = Number.isInteger(info.shell_pid) ? info.shell_pid : null;
  const fgPid = info.foreground_processes && info.foreground_processes[0] && Number.isInteger(info.foreground_processes[0].pid) ? info.foreground_processes[0].pid : null;
  let tty = normalizeTty(info.tty);
  try {
    if (!tty) tty = shellPid ? await ttyOfPid(shellPid) : fgPid ? await ttyOfPid(fgPid) : null;
    if (!tty) throw unverified('the pane has no terminal device');
    if (fgPid && (await ttyOfPid(fgPid)) !== tty) throw unverified('the foreground process is on another terminal');
  } catch (e) { throw e instanceof ApiError ? e : unverified(`ps failed (${why(e)})`); }
  let out;
  try { out = await run(STTY, [STTY_DEVICE_FLAG, '/dev/' + tty, 'size']); }
  catch (e) { throw unverified(`stty failed (${why(e)})`); }
  const m = /^(\d{1,4}) (\d{1,4})$/.exec(out);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw unverified('stty gave an unreadable size');
  return { rows: Number(m[1]), cols: Number(m[2]), tty };
}

// The size to pass to a controller: it must agree with the one number Herdr does report (rows).
function verifiedSize(size, pane) {
  const sc = pane && pane.scroll;
  if (!sc || !Number.isInteger(sc.viewport_rows)) throw unverified('Herdr reports no scroll metrics for this pane');
  if (size.rows !== sc.viewport_rows) throw unverified(`the terminal has ${size.rows} rows but Herdr reports ${sc.viewport_rows}`);
  return size;
}

module.exports = { readPaneSize, verifiedSize };
