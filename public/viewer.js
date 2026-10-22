'use strict';
// The numbers behind the pane viewer. No DOM access: app.js passes in what it measured, so the rules can be tested.
(function (root) {
  const RUN_CAP = 120; // pane_click accepts at most 120 characters of expect_text
  const POLL_MS = 1500;
  const BACKOFF_MS = 5000;
  const MAX_LINES = 2000;
  const blank = (c) => /\s/u.test(c);

  function runAt(row, column) {
    const cps = Array.from(String(row));
    if (column < 0 || column >= cps.length || blank(cps[column])) return null;
    let a = column; let b = column + 1;
    while (a > 0 && !blank(cps[a - 1])) a -= 1;
    while (b < cps.length && !blank(cps[b])) b += 1;
    if (b - a > RUN_CAP) { a = Math.min(Math.max(a, column - RUN_CAP / 2), b - RUN_CAP); b = a + RUN_CAP; }
    return { text: cps.slice(a, b).join(''), start: a, end: b };
  }

  // The portal refuses a click on fewer than two non-blank characters; saying so before the request saves a round trip.
  const tooShort = (run) => !run || Array.from(run.text).filter((c) => !blank(c)).length < 2;

  // m: the box's page position, its padding, its scroll offsets and the measured size of one character cell.
  function cellAt(x, y, m, rows = Infinity) {
    if (!(m.cw > 0 && m.lh > 0)) return null;
    const column = Math.floor((x - m.left - m.padLeft + m.scrollLeft) / m.cw);
    const row = Math.floor((y - m.top - m.padTop + m.scrollTop) / m.lh);
    return column < 0 || row < 0 || row >= rows ? null : { column, row };
  }

  const atBottom = (el, slack = 4) => el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
  const keepPlace = (scrollHeight, clientHeight, fromBottom) => Math.max(0, scrollHeight - clientHeight - fromBottom);
  const nextPollDelay = (failures) => (failures > 0 ? BACKOFF_MS : POLL_MS);
  const nextLines = (n) => Math.min(MAX_LINES, n * 2);
  const canLoadMore = (n) => n < MAX_LINES;

  const api = { runAt, tooShort, cellAt, atBottom, keepPlace, nextPollDelay, nextLines, canLoadMore };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.HerdrViewer = api;
})(typeof window !== 'undefined' ? window : globalThis);
