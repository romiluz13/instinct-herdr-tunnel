'use strict';
// lib/screen-guard.js: pure rules that decide whether a click can be tied to what the caller saw.
const test = require('node:test');
const assert = require('node:assert/strict');
const { locate, confirmWord, choiceRow, choiceNear, nonSpaceCount } = require('../lib/screen-guard');

// row, expect_text, column -> status. Columns are cells; the guard may only treat them as code point indexes when
// nothing before the matched span can be wider or narrower than one cell.
const CASES = [
  ['plain ascii, click inside the text', 'build finished: npm test passed', 'npm test', 20, 'ok'],
  ['first and last cell of the span', 'build finished: npm test passed', 'npm test', 16, 'ok'],
  ['one past the span is a different cell', 'build finished: npm test passed', 'npm test', 24, 'screen_changed'],
  ['the text is not there any more', 'build finished: npm run passed', 'npm test', 20, 'screen_changed'],
  ['the same text twice: the occurrence under the column counts', 'ab cd ab cd', 'ab', 7, 'ok'],
  ['the same text twice: the gap between them does not', 'ab cd ab cd', 'ab', 5, 'screen_changed'],
  ['box drawing counts as one cell', '── Save ──', 'Save', 4, 'ok'],
  ['an ambiguous-width ellipsis counts as one cell', 'loading… done', 'done', 10, 'ok'],
  ['a bullet counts as one cell', '● ready to go', 'ready', 3, 'ok'],
  ['precomposed é is one cell', 'café open', 'open', 6, 'ok'],
  ['decomposed é carries a combining mark: not mappable', 'café open', 'open', 7, 'row_not_cell_mappable'],
  ['a wide CJK character before the span: not mappable', '中文 Save', 'Save', 6, 'row_not_cell_mappable'],
  ['hangul syllables are wide', '한글 Save', 'Save', 6, 'row_not_cell_mappable'],
  ['fullwidth forms are wide', 'ＡＢ Save', 'Save', 6, 'row_not_cell_mappable'],
  ['an emoji with a variation selector: not mappable', '❤️ Save', 'Save', 3, 'row_not_cell_mappable'],
  ['a zero-width space: not mappable', 'Sa​ve now', 'now', 6, 'row_not_cell_mappable'],
  ['an astral code point: not mappable', '\u{1D49C} Save', 'Save', 3, 'row_not_cell_mappable'],
  ['Claude Code row marker: nothing to its right is clickable', '⏺ Read file', 'Read file', 3, 'row_not_cell_mappable'],
  ['presentation forms for vertical text are wide (U+FE10)', '\uFE10\uFE10 Save', 'Save', 3, 'row_not_cell_mappable'],
  ['an angle bracket from the wide block (U+2329)', '\u2329 Save', 'Save', 2, 'row_not_cell_mappable'],
  ['Hangul Jamo Extended-A is wide (U+A960)', '\uA960 Save', 'Save', 2, 'row_not_cell_mappable'],
  ['a byte order mark is a zero-width format character (U+FEFF)', '\uFEFF Save', 'Save', 2, 'row_not_cell_mappable'],
  ['a soft hyphen is a format character (U+00AD)', 'a\u00AD Save', 'Save', 3, 'row_not_cell_mappable'],
  ['a bidi control is a format character (U+202E)', '\u202E Save', 'Save', 2, 'row_not_cell_mappable'],
  ['an invisible operator is a format character (U+2062)', 'a\u2062 Save', 'Save', 3, 'row_not_cell_mappable'],
  ['a conjoining jamo vowel is zero width (U+1161)', '\u1161 Save', 'Save', 2, 'row_not_cell_mappable'],
  ['a conjoining jamo tail is zero width (U+D7CB)', '\uD7CB Save', 'Save', 2, 'row_not_cell_mappable'],
  ['a pipe is an ordinary character', '| name | Save |', 'Save', 9, 'ok'],
  ['a pipe before the span in a table row', 'a|b Save', 'Save', 4, 'ok'],
  ['a wide character AFTER the span does not matter', 'Save 中文', 'Save', 1, 'ok'],
  ['a wide character inside the span: not mappable', 'a 中 b', '中 b', 3, 'row_not_cell_mappable'],
];
for (const [name, row, text, column, want] of CASES) {
  test(`locate: ${name}`, () => assert.equal(locate(row, text, column).status, want));
}

test('locate reports the span in code points so the caller can see what was matched', () => {
  assert.deepEqual(locate('── Save ──', 'Save', 4), { status: 'ok', start: 3, end: 7 });
});

test('locate treats the row raw: leading blanks and trailing blanks count as cells', () => {
  assert.equal(locate('   Save', 'Save', 3).status, 'ok');
  assert.equal(locate('   Save', 'Save', 2).status, 'screen_changed');
});

const WORDS = [
  ['Allow once', 'allow'], ['approve it', 'approve'], ['accept', 'accept'], ['Yes, proceed', 'yes'], ['always', 'always'], ['Deny', 'deny'],
  ['reject all', 'reject'], ['No', 'no'], ['proceed', 'proceed'], ['continue', 'continue'], ['CONFIRM', 'confirm'], ['ok', 'ok'], ['trust this folder', 'trust'],
  ['[y/n]', 'y'], ['(Y)', 'y'], ['n)', 'n'], ['a-no-b', 'no'],
];
for (const [text, word] of WORDS) test(`confirmWord finds "${word}" in ${JSON.stringify(text)}`, () => assert.equal(confirmWord(text), word));

for (const text of ['Save', 'known issues', 'Nothing here', 'okay', "don't", 'yesterday', 'allowance', 'npm test']) {
  test(`confirmWord leaves ${JSON.stringify(text)} alone: only whole words count`, () => assert.equal(confirmWord(text), null));
}

test('confirmWord checks every text it is given', () => assert.equal(confirmWord('Save', 'then Allow'), 'allow'));

test('nonSpaceCount counts code points that are not whitespace', () => {
  assert.equal(nonSpaceCount('  a  '), 1);
  assert.equal(nonSpaceCount('a b'), 2);
  assert.equal(nonSpaceCount('　  ab'), 2);
});

const CHOICES = ['● 1. Allow once', '> 1. Yes', '  (1) Yes, proceed', ' ❯ 1. Yes', '  2) Skip', '[ ] Install', '[x] Install', '( ) one', '(•) one', '[ Run ]   [ Skip ]', '< Yes >    < No >',
  '[Run] [Skip]', '( Run )   ( Skip )', '│ ❯ 1. Run it now │', ' ❯ Run it now', '> Run it now', 'a) Run', '[1] Run', '1: Run', '→ 1. Run', '☐ Install left-pad', '[ Ja ]   [ Nein ]', '[ Deploy ] | [ Cancel ]', '┃ [x] Install ┃',
  '[ Run ]   [ Skip', '[ Run ]   [ Skip the database migration and the seed step ]', '◉ Run', '○ Skip'];
for (const row of CHOICES) test(`choiceRow: ${JSON.stringify(row)} is a menu entry`, () => assert.ok(choiceRow(row)));
for (const row of ['build finished: npm test passed', '[ Settings ]', 'version 1.5 released', '1.5 seconds', 'see (1) below', '- list item', '• bullet item', 'Total   [ 12 ]', '', 'see [the docs](./README.md)', 'grid[i][j]', '✔ passes', '[Run][Skip]']) {
  test(`choiceRow: ${JSON.stringify(row)} is not`, () => assert.equal(choiceRow(row), null));
}

// Menus that are not one row: a lone button per row, and rows that only describe or wrap an entry.
const NEAR = [
  ['one button per row', ['', '[ Run ]', '[ Skip ]', ''], 1],
  ['the wrapped second row of an entry', ['Install and run?', '❯ 1. Run the install script for the', '     database package', ''], 2],
  ['the description under an entry', ['  a) Run', '     Runs every tool without asking', ''], 1],
  ['two rows below the entry', ['  1. Run', 'x', 'y'], 2],
  ['two rows above the entry', ['x', 'y', '  1. Run'], 0],
];
for (const [name, rows, index] of NEAR) test(`choiceNear: ${name}`, () => assert.ok(choiceNear(rows, index)));
test('choiceNear: a lone button, or an entry three rows away, is an ordinary click', () => {
  assert.equal(choiceNear(['', '[ Settings ]', 'version 1.5 released'], 1), null);
  assert.equal(choiceNear(['  1. Run', 'x', 'y', 'z'], 3), null);
  assert.equal(choiceNear(['build finished: npm test passed'], 0), null);
});

test('choiceNear stays fast on a row of runaway length, whatever it is made of', () => {
  const rows = { spaces: 'x' + ' '.repeat(200000) + 'y', borders: 'x' + ' │'.repeat(100000), bracket: '[a]' + ' '.repeat(200000) + 'y', openers: '[ '.repeat(100000), bars: '[a]' + ' |'.repeat(100000) };
  const t0 = Date.now();
  for (const row of Object.values(rows)) choiceNear(Array(5).fill(row), 2);
  assert.ok(Date.now() - t0 < 1000, 'five rows of every shape take well under a second');
});
