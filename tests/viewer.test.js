'use strict';
// public/viewer.js: the numbers behind the pane viewer. No DOM here; app.js passes measurements in.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/viewer');

test('runAt returns the run of non-blank characters around a cell, from the raw row', () => {
  assert.deepEqual(V.runAt('build finished: npm test passed', 17), { text: 'npm', start: 16, end: 19 });
  assert.deepEqual(V.runAt('npm test', 0), { text: 'npm', start: 0, end: 3 });
  assert.deepEqual(V.runAt('npm test', 7), { text: 'test', start: 4, end: 8 });
});

test('runAt is null on a blank cell, outside the row, or on an empty row', () => {
  assert.equal(V.runAt('npm test', 3), null);
  assert.equal(V.runAt('npm test', 8), null);
  assert.equal(V.runAt('npm test', -1), null);
  assert.equal(V.runAt('', 0), null);
});

test('runAt counts code points, not UTF-16 units', () => {
  assert.deepEqual(V.runAt('\u{1D49C}bc de', 2), { text: '\u{1D49C}bc', start: 0, end: 3 });
});

test('a run longer than 120 characters is cut to 120 that still contain the cell', () => {
  const row = 'x'.repeat(300);
  for (const column of [0, 5, 150, 299]) {
    const r = V.runAt(row, column);
    assert.equal(Array.from(r.text).length, 120);
    assert.ok(r.start <= column && column < r.end, `column ${column} inside ${r.start}-${r.end}`);
  }
});

test('tooShort: fewer than two non-blank characters cannot be clicked safely', () => {
  assert.equal(V.tooShort(null), true);
  assert.equal(V.tooShort({ text: 'a' }), true);
  assert.equal(V.tooShort({ text: 'ab' }), false);
});

test('cellAt maps a point to a zero-based cell using the measured character box and the scroll offsets', () => {
  const m = { left: 100, top: 50, padLeft: 10, padTop: 10, scrollLeft: 0, scrollTop: 0, cw: 8, lh: 16 };
  assert.deepEqual(V.cellAt(110, 60, m), { column: 0, row: 0 });
  assert.deepEqual(V.cellAt(117, 75, m), { column: 0, row: 0 });
  assert.deepEqual(V.cellAt(118, 76, m), { column: 1, row: 1 });
  assert.deepEqual(V.cellAt(110 + 8 * 20 + 3, 60 + 16 * 5 + 15, m), { column: 20, row: 5 });
  assert.deepEqual(V.cellAt(110, 60, { ...m, scrollTop: 32, scrollLeft: 16 }), { column: 2, row: 2 });
});

test('cellAt is null on the padding, without measurements, and past the last row', () => {
  const m = { left: 0, top: 0, padLeft: 10, padTop: 10, scrollLeft: 0, scrollTop: 0, cw: 8, lh: 16 };
  assert.equal(V.cellAt(5, 20, m), null);
  assert.equal(V.cellAt(20, 5, m), null);
  assert.equal(V.cellAt(20, 20, { ...m, cw: 0 }), null);
  assert.equal(V.cellAt(20, 10 + 16 * 3, m, 3), null);
  assert.deepEqual(V.cellAt(20, 10 + 16 * 2, m, 3), { column: 1, row: 2 });
});

test('atBottom allows a few pixels of rounding; keepPlace holds the distance from the bottom', () => {
  assert.equal(V.atBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
  assert.equal(V.atBottom({ scrollHeight: 1000, scrollTop: 597, clientHeight: 400 }), true);
  assert.equal(V.atBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }), false);
  assert.equal(V.keepPlace(1600, 400, 100), 1100);
  assert.equal(V.keepPlace(300, 400, 0), 0, 'content shorter than the box');
});

test('polling is every 1.5 s and backs off to 5 s while requests fail', () => {
  assert.equal(V.nextPollDelay(0), 1500);
  assert.equal(V.nextPollDelay(1), 5000);
  assert.equal(V.nextPollDelay(7), 5000);
});

test('Load more doubles the line count up to the 2000 cap', () => {
  assert.equal(V.nextLines(500), 1000);
  assert.equal(V.nextLines(1000), 2000);
  assert.equal(V.nextLines(2000), 2000);
  assert.equal(V.canLoadMore(1000), true);
  assert.equal(V.canLoadMore(2000), false);
});
