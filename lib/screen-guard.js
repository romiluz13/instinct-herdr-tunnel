'use strict';
// Pure rules for pane_click: tie a click to the text the caller saw, and keep it off anything that could answer a dialog.
// Nothing here talks to Herdr or the terminal.

// Code points that may take other than one cell, or none. A row holding one at or before the clicked text cannot be
// mapped from a code point index to a cell column, so the click is refused. JavaScript has no East_Asian_Width property
// escape, so the wide and fullwidth blocks are listed. Ambiguous-width characters (box drawing, an ellipsis, a bullet)
// are counted as one cell, which is what terminals do by default.
const NOT_ONE_CELL = new RegExp([
  '[\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA000-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE30-\\uFE6F\\uFF00-\\uFF60\\uFFE0-\\uFFE6\\u2329\\u232A\\uA960-\\uA97C\\uFE10-\\uFE19\\u1160-\\u11FF\\uD7B0-\\uD7FF' +
  '\\u200B-\\u200F\\u2060\\uFE00-\\uFE0F\\u{10000}-\\u{10FFFF}]',
  '\\p{Extended_Pictographic}',
  '\\p{M}',
  '\\p{Cf}',
].join('|'), 'u');

// Words that confirm or refuse something. A click on one answers a dialog, and that is the owner's decision.
const CONFIRM_WORDS = new Set(['allow', 'approve', 'accept', 'yes', 'trust', 'always', 'deny', 'reject', 'no', 'proceed', 'continue', 'confirm', 'ok', 'y', 'n']);
const WORD = /[\p{L}\p{N}_]+/gu;

// A menu entry that a click would choose: an option number or letter, a check, radio or ballot box, a cursor, or two
// buttons side by side. Menus come in too many shapes for a screen parser to know them all, so the clicked row and the
// rows around it are judged, after a leading or trailing box border is dropped. This is pattern matching, not a guarantee.
const BORDER = /^[\s│┃║|]+|(?<![\s│┃║|])[\s│┃║|]+$/gu;
const MARKER = '[>❯›▶►➤→▸»●○◉◯•*+-]';
const CHOICE_START = new RegExp('^(?:' + MARKER + '\\s*)?(?:\\(?\\d{1,2}[.):]|\\(?[A-Za-z][.)]|\\[[ xX*✓✔]?\\]|\\[\\w{1,2}\\]|\\([ xX*•●]?\\)|[☐☑☒])(?=\\s)', 'u');
const CURSOR_ROW = /^[>❯›▶►➤→▸»◉◯○]\s+\S/u;
const BUTTON = '(?:\\[\\s*[^\\]\\s][^\\]]{0,24}\\]|<\\s*[^<>\\s][^<>]{0,24}>|\\(\\s*[^()\\s][^()]{0,24}\\))';
const BUTTON_OPEN = '(?:\\[\\s*[^\\]\\s]|<\\s*[^<>\\s]|\\(\\s*[^()\\s])';
// The second button only has to start: a narrow pane cuts a row off, and a long label is still a button.
const BUTTON_PAIR = new RegExp(BUTTON + '(?:\\s+|\\s*[|/·•]\\s*)' + BUTTON_OPEN, 'u');
const LONE_BUTTON = new RegExp('^' + BUTTON + '$', 'u');
const REACH = 2;

const nonSpaceCount = (s) => Array.from(String(s)).filter((c) => !/\s/u.test(c)).length;

function confirmWord(...texts) {
  for (const t of texts) for (const w of String(t).toLowerCase().match(WORD) || []) if (CONFIRM_WORDS.has(w)) return w;
  return null;
}

// A visible row is at most as wide as the terminal, and a click column is at most 1000: the cut keeps the patterns off a runaway row.
const WIDEST = 1000;
const bare = (row) => String(row).slice(0, WIDEST).replace(BORDER, '');

function choiceRow(row) {
  const r = bare(row);
  const m = CHOICE_START.exec(r) || CURSOR_ROW.exec(r) || BUTTON_PAIR.exec(r);
  return m ? m[0].trim().slice(0, 24) : null;
}

// The clicked row, the REACH rows above it (a wrapped or described option sits under its entry) and the REACH rows
// below it. Two rows that are each a single button count too: a vertical pair of buttons is a menu.
function choiceNear(rows, index) {
  const lo = Math.max(0, index - REACH); const hi = Math.min(rows.length - 1, index + REACH);
  const buttons = [];
  for (let i = lo; i <= hi; i++) {
    const hit = choiceRow(rows[i]);
    if (hit) return hit;
    if (LONE_BUTTON.test(bare(rows[i]))) buttons.push(bare(rows[i]));
  }
  return buttons.length > 1 ? buttons[0].slice(0, 24) : null;
}

// Is `text` on the raw `row` under the zero-based cell `column`? Offsets are code points. `ok` carries the matched span;
// `screen_changed` means the text is not under that column (any more); `row_not_cell_mappable` means a code point at or
// before the end of the match may not be one cell wide, so the column cannot be trusted to point into the text.
function locate(row, text, column) {
  const cps = Array.from(row); const want = Array.from(text);
  const spans = [];
  for (let i = Math.max(0, column - want.length + 1); i <= column && i + want.length <= cps.length; i++) {
    if (want.every((c, k) => cps[i + k] === c)) spans.push([i, i + want.length]);
  }
  if (!spans.length) return { status: 'screen_changed' };
  const reach = Math.max(...spans.map((x) => x[1]));
  if (cps.slice(0, reach).some((c) => NOT_ONE_CELL.test(c))) return { status: 'row_not_cell_mappable' };
  return { status: 'ok', start: spans[0][0], end: spans[0][1] };
}

module.exports = { locate, confirmWord, choiceRow, choiceNear, nonSpaceCount };
