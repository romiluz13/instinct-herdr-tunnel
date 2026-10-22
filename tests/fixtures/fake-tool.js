#!/usr/bin/env node
'use strict';
// Fake `ps` and `stty` for the pane-size read: `fake-tool.js ps -o tty= -p PID` and `fake-tool.js stty -f /dev/TTY size`.
// ps.json maps a pid to the tty ps prints (default ttys001; ?? means no terminal); stty-size.txt holds "rows cols" (default 47 64).
// Every call is appended to tool-calls.jsonl so a test can see what ran.
const fs = require('fs');
const [tool, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_HERDR_DIR;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { return d; } };
fs.appendFileSync(dir + '/tool-calls.jsonl', JSON.stringify({ tool, args }) + '\n');
const delay = readJson('tool-delay.json', 0);
if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
if (tool === 'ps') {
  const pid = args[args.indexOf('-p') + 1];
  const map = readJson('ps.json', {});
  if (map[pid] === 'FAIL') process.exit(1);
  console.log(map[pid] === undefined ? 'ttys001' : map[pid]);
} else if (tool === 'stty') {
  const fail = readJson('stty-fail.json', false);
  if (fail) process.exit(1);
  let size = '47 64'; try { size = fs.readFileSync(dir + '/stty-size.txt', 'utf8').trim(); } catch { /* default */ }
  console.log(size);
} else process.exit(2);
