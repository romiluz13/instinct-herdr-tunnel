'use strict';
// Pure helpers for agent_decision: find the single-select option list of a blocked agent's dialog in rendered
// terminal text, fingerprint it, and apply the refuse list. Nothing here talks to Herdr.
//
// Recognised shape (observed live in Claude Code, 2026-10-13): a vertical list, one option per line, all labels
// starting in the same column, the highlighted option carrying a cursor glyph in front of it, nothing but a footer
// hint below it. Numbered options ("1. Yes") are handled the same way. Anything else (horizontal buttons, free text,
// a list with other content below it) is "not recognised" and the portal sends nothing.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CURSOR = '❯›▶►➤'; // ASCII '>' is left out on purpose: quoted prose and markdown start with it
const CURSOR_LINE = new RegExp(`^(\\s{0,4})([${CURSOR}])(\\s+)(\\S.*)$`);
const CURSOR_GLYPH = new RegExp(`[${CURSOR}]`);
const RULE = /[─━═]{10,}/;
const FOOTER = /\b(to confirm|to cancel|to navigate|to select|to go back|esc to|enter to)\b/i;
const SCAN_WINDOW = 100; // rows above the first option searched for the dialog's top border

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const lead = (l) => l.length - l.trimStart().length;

function parseDialog(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\s+$/, ''));
  // Only the lowest cursor line can be the live dialog: a list higher up is stale, and anything else below the
  // options (a prompt, a question) means the screen is not a plain dialog.
  let c = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (CURSOR_LINE.test(lines[i])) { c = i; break; }
  if (c < 0) return null;
  const m = CURSOR_LINE.exec(lines[c]);
  const col = m[1].length + 1 + m[3].length;
  const plain = (l) => l.trim() !== '' && l.length < 140 && !RULE.test(l) && !FOOTER.test(l);
  const isOpt = (l) => plain(l) && lead(l) === col;
  const isCont = (l) => plain(l) && lead(l) > col; // wrapped remainder of the option above
  let first = c; while (first > 0 && (isOpt(lines[first - 1]) || isCont(lines[first - 1]))) first -= 1;
  while (first < c && isCont(lines[first])) first += 1;
  let last = c; while (last + 1 < lines.length && (isOpt(lines[last + 1]) || isCont(lines[last + 1]))) last += 1;
  for (let i = last + 1; i < lines.length; i++) if (lines[i].trim() && !FOOTER.test(lines[i])) return null;
  const options = [];
  for (let i = first; i <= last; i++) {
    if (i === c || isOpt(lines[i])) {
      const raw = i === c ? m[4] : lines[i].slice(col);
      const num = /^(\d{1,2})[.)]\s+(\S.*)$/.exec(raw);
      options.push({ index: options.length, key: num ? num[1] : null, label: norm(num ? num[2] : raw), selected: i === c });
    } else if (options.length) options[options.length - 1].label = norm(`${options[options.length - 1].label} ${lines[i]}`);
  }
  if (options.length < 2) return null;
  // near = the closest rule above the options (its presence means the dialog's top border is on screen); far = the
  // topmost rule within the window. Scanning and fingerprinting start at `far`, so a rule printed INSIDE an
  // (agent-controlled) command cannot hide the text above it.
  let near = -1; let far = -1;
  for (let i = first - 1; i >= Math.max(0, first - SCAN_WINDOW); i--) if (RULE.test(lines[i])) { if (near < 0) near = i; far = i; }
  // two lists inside one frame: which one has the focus is unknowable from the text
  if (near >= 0) for (let i = near + 1; i < first; i++) if (CURSOR_LINE.test(lines[i])) return null;
  const framed = near >= 0; // without a visible top border a small pane may have clipped the dialog (seen live)
  const cut = (from) => lines.slice(from).map((l, i) => (from + i === c ? l.replace(CURSOR_GLYPH, ' ') : l).replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  const scan = cut(framed ? far : Math.max(0, first - 30));
  // Fingerprint of everything that was scanned, cursor blanked and the blinking status marker at the start of a line
  // (⏺ seen flipping to a space while the dialog stayed put) normalised, so only a real content change alters it.
  const stable = scan.split('\n').map((l) => l.replace(/^(\s*)[⏺●○✻✶✷✸✹✺✳✢]\s?/, '$1 ')).join('\n');
  return { options, cursor: options.findIndex((o) => o.selected), framed, scan, hash: crypto.createHash('sha256').update(stable).digest('hex').slice(0, 24) };
}

function resolveOption(dialog, wanted) {
  const w = norm(wanted);
  const hit = dialog.options.filter((o) => (o.key !== null && o.key === w) || o.label === w || (o.key !== null && `${o.key}. ${o.label}` === w));
  if (hit.length === 0) return { error: 'option_not_found' };
  if (hit.length > 1) return { error: 'option_ambiguous' };
  return { option: hit[0] };
}

// Minimal keys: arrow presses to reach the option from the cursor (no wrap-around), Enter is sent separately.
const movesTo = (dialog, index) => {
  const d = index - dialog.cursor;
  return Array(Math.abs(d)).fill(d < 0 ? 'up' : 'down');
};
const inverse = (moves) => moves.map((k) => (k === 'up' ? 'down' : 'up'));

// ---- refuse list: fail closed, the answer belongs to the owner ----
const RULES = [
  ['deletion', /\b(rm|rmdir|unlink|shred|truncate)\b|\bdelet(?:e|es|ed|ing|ion)\b|\bdrop\b|\breset\s+-{1,2}hard\b|\bgit\s+clean\b|\bgit\s+branch\s+-d\b|\bgit\s+checkout\s+--(?:\s|$)|\bgit\s+push\b[^\n]*\s(?:--force\b|-f\b)|\bmv\b[^\n]*\/dev\/null/i],
  ['sudo', /\b(sudo|doas)\b|\b(?:as|with)\s+(?:root|administrator)\b/i],
  ['credentials', /\b(?:passwords?|passwd|passphrases?|credentials?|secrets?|api[ _-]?keys?|private[ _-]?keys?|access[ _-]?tokens?|auth[ _-]?tokens?|bearer|tokens?|keychain)\b|id_rsa|id_ed25519|\.pem\b|\.p12\b|\.ssh\b|\.aws\b|\.npmrc|\.netrc|\.git-credentials|(?:^|[\s/'"`])\.env(?:\.[\w-]+)?(?=$|[\s'"`:,)])/i],
];
// A dialog that elides part of its content cannot be checked.
const TRUNCATED = /\+\d+\s+(?:more\s+)?lines?\b|ctrl\+o to expand|\(truncated\)|\[truncated\]|\.\.\.\s*\(\d+ more/i;
const looksTruncated = (text) => TRUNCATED.test(text);
const HARMLESS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

// realpath of the nearest existing ancestor plus the not-yet-existing rest (macOS: /tmp is a symlink to /private/tmp).
function canon(p) {
  const rest = [];
  for (let cur = p; ;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* go up */ }
    const up = path.dirname(cur);
    if (up === cur) return p;
    rest.push(path.basename(cur)); cur = up;
  }
}

// Every path-looking token of the text that is, or may be, outside the working directory. Unknowable targets
// ($VAR/…, ~user/…, any `..` segment) count as outside; a working directory that is the home directory or the
// filesystem root is no workspace at all, so every absolute path counts.
function outsideWorkspace(text, cwd) {
  let root = cwd ? canon(cwd) : null;
  if (root && (root === os.homedir() || root === canon(os.homedir()) || root.split(path.sep).filter(Boolean).length < 2)) root = null;
  const found = [];
  let prev = '';
  for (const raw of text.split(/[\s"'`<>|;&(),=]+/)) {
    const t = raw.replace(/[.:;!?]+$/, '');
    const afterFlag = prev.startsWith('-'); prev = t;
    if (t === '/' && afterFlag) { found.push('/'); continue; } // `tar -C /`
    if (t.length < 2 || !t.includes('/') || t.includes('://') || HARMLESS.has(t)) continue;
    if (/\$|~[^/]/.test(t) && !t.startsWith('$HOME/') && !t.startsWith('~/')) { found.push(t); continue; }
    if (/(^|\/)\.\.(\/|$)/.test(t)) { found.push(t); continue; }
    let abs;
    if (t.startsWith('~/')) abs = path.join(os.homedir(), t.slice(2));
    else if (t.startsWith('$HOME/')) abs = path.join(os.homedir(), t.slice(6));
    else if (path.isAbsolute(t)) abs = t;
    else continue; // plain relative path (src/a.js, ./x): inside the working directory
    abs = canon(path.resolve(abs));
    if (!root || !(abs === root || abs.startsWith(root + path.sep))) found.push(abs);
  }
  return found;
}

// Returns null when nothing matched, otherwise the category and the matched keyword only (never surrounding text:
// for the credentials category that text could be the secret itself).
function refuseReason(dialogText, optionText, cwd) {
  const text = `${dialogText}\n${optionText || ''}`;
  // Variants that can only ADD refusals: quotes/backslashes removed (r""m, \rm), and every pair of neighbouring
  // lines joined at the break (long lines soft-wrap, so a keyword can be cut: "sud" / "o").
  const rows = text.split('\n');
  const variants = [text, text.replace(/["'`\\]/g, ''), ...rows.slice(0, -1).map((l, i) => l.trimEnd() + rows[i + 1].trimStart())];
  for (const [category, re] of RULES) {
    for (const v of variants) {
      const m = re.exec(v);
      if (m) return { category, matched: norm(m[0]).slice(0, 24) };
    }
  }
  if (outsideWorkspace(text, cwd).length) return { category: 'overwrite_outside_workspace', matched: 'path outside workspace' };
  return null;
}

module.exports = { parseDialog, resolveOption, movesTo, inverse, refuseReason, looksTruncated, outsideWorkspace, norm };
