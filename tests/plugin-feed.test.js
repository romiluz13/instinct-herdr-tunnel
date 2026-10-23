'use strict';
// The plugin's feed library: reading the portal's audit log and turning entries into screen rows and sidebar tags.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const feed = require('../plugin/lib/feed');

const entry = (over = {}) => ({
  timestamp: '2026-10-23T05:05:47.062Z', action: 'herdr.agent_prompt', session: 'default', pane: 'w36:p1', option: null,
  result: 'input_sent', http_status: 200, error_code: null, category: null, replayed: false, request_id: 'r-1', idempotency_key: 'k-1', intent_id: 'i-1', ...over,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hp-feed-'));

test('parseLine reads one audit line and refuses anything that is not an audit entry', () => {
  assert.equal(feed.parseLine(JSON.stringify(entry())).pane, 'w36:p1');
  for (const bad of ['', '   ', 'not json', '[]', '"x"', '{"no":"action"}', '{"action":5}']) assert.equal(feed.parseLine(bad), null, bad);
});

test('verb drops the namespace and the agent_/pane_ prefix', () => {
  assert.equal(feed.verb('herdr.agent_prompt'), 'prompt');
  assert.equal(feed.verb('herdr.pane_run'), 'run');
  assert.equal(feed.verb('herdr.agent_send_keys'), 'send keys');
  assert.equal(feed.verb('herdr.put_file'), 'put file');
  assert.equal(feed.verb('herdr.pane_scroll'), 'scroll');
  assert.equal(feed.verb(undefined), 'unknown');
});

test('tone separates sent, queued, refused, needs review and reads', () => {
  const t = (result, http_status = 200) => feed.tone(entry({ result, http_status }));
  assert.equal(t('input_sent'), 'ok');
  assert.equal(t('written'), 'ok');
  assert.equal(t('input_sent_queued'), 'queued');
  assert.equal(t('rejected', 409), 'refused');
  assert.equal(t('failed', 502), 'refused');
  assert.equal(t('needs_review', 200), 'review');
  assert.equal(t('read'), 'read');
  assert.equal(t('something_new'), 'other');
});

test('formatTime shows the entry time in the zone asked for', () => {
  assert.equal(feed.formatTime('2026-10-23T05:05:47.062Z', 'UTC'), '05:05:47');
  assert.equal(feed.formatTime('2026-10-23T05:05:47.062Z', 'Asia/Jerusalem'), '08:05:47');
  assert.equal(feed.formatTime('garbage', 'UTC'), '--:--:--');
});

test('row is one line of at most the width, with the time, the pane, the verb and the outcome', () => {
  const r = feed.row(entry({ result: 'rejected', http_status: 409, error_code: 'blocked_requires_decision' }), { width: 80, color: false, timeZone: 'UTC' });
  assert.match(r, /^05:05:47 +prompt +w36:p1 +refused 409 blocked_requires_decision$/);
  assert.ok(feed.row(entry(), { width: 20, color: false, timeZone: 'UTC' }).length <= 20);
  assert.equal(feed.row(entry(), { width: 80, color: false, timeZone: 'UTC' }).includes('\n'), false);
});

test('row prints a result named like an object property as text, and never cuts a character in half', () => {
  const odd = feed.row(entry({ result: '__proto__' }), { width: 80, color: false, timeZone: 'UTC' });
  assert.match(odd, /proto\s*$/);
  assert.doesNotMatch(odd, /\[object|native code/);
  const cut = feed.row(entry({ pane: '\u{1F600}'.repeat(30) }), { width: 30, color: false, timeZone: 'UTC' });
  assert.doesNotMatch(cut, /[\ud800-\udbff]$/, 'no lone surrogate at the end');
});

test('row colours by tone only when colour is on, and never counts escape codes toward the width', () => {
  const on = feed.row(entry(), { width: 40, color: true, timeZone: 'UTC' });
  const off = feed.row(entry(), { width: 40, color: false, timeZone: 'UTC' });
  assert.match(on, /\x1b\[/);
  assert.doesNotMatch(off, /\x1b\[/);
  assert.equal(on.replace(/\x1b\[[0-9;]*m/g, ''), off);
});

test('row never prints control characters from the log', () => {
  const r = feed.row(entry({ pane: 'w1:p1\x1b[2J\x07', error_code: 'a\nb' }), { width: 120, color: false, timeZone: 'UTC' });
  assert.doesNotMatch(r, /[\x00-\x08\x0b-\x1f\x7f]/);
});

test('render fills exactly the screen: header, the newest entries that fit, footer', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry({ request_id: 'r' + i, pane: 'w1:p' + i }));
  const lines = feed.render({ entries, width: 60, height: 12, scroll: 0, paused: false, health: 'up', color: false, timeZone: 'UTC' });
  assert.equal(lines.length, 12);
  assert.ok(lines.every((l) => l.length <= 60));
  assert.match(lines[0], /portal up/);
  assert.ok(lines.some((l) => l.includes('w1:p49')), 'the newest entry is on screen');
  assert.ok(!lines.some((l) => l.includes('w1:p0 ')), 'the oldest is not');
  assert.match(lines[lines.length - 1], /q quit/);
});

test('render scrolled back shows older entries; paused and a down portal are said in the header', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry({ request_id: 'r' + i, pane: 'w1:p' + i }));
  const live = feed.render({ entries, width: 60, height: 12, scroll: 0, paused: false, health: 'down', color: false, timeZone: 'UTC' });
  const back = feed.render({ entries, width: 60, height: 12, scroll: 20, paused: true, health: 'up', color: false, timeZone: 'UTC' });
  assert.match(live[0], /portal down/);
  assert.match(back[0], /paused/);
  assert.ok(!back.some((l) => l.includes('w1:p49 ')));
  assert.ok(back.some((l) => l.includes('w1:p29')));
});

test('render with no entries says so instead of drawing an empty box', () => {
  const lines = feed.render({ entries: [], width: 60, height: 8, scroll: 0, paused: false, health: 'up', color: false, timeZone: 'UTC' });
  assert.equal(lines.length, 8);
  assert.ok(lines.some((l) => /no portal activity yet/.test(l)));
});

test('AuditTail: starts at the end, then returns only what was appended, whole lines only', () => {
  const dir = tmp(); const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, JSON.stringify(entry({ request_id: 'old' })) + '\n');
  const tail = new feed.AuditTail(file, { fromEnd: true });
  assert.deepEqual(tail.poll(), []);
  const line = JSON.stringify(entry({ request_id: 'new' }));
  fs.appendFileSync(file, line.slice(0, 30));
  assert.deepEqual(tail.poll(), [], 'a half written line waits');
  fs.appendFileSync(file, line.slice(30) + '\n' + 'garbage line\n' + JSON.stringify(entry({ request_id: 'newer' })) + '\n');
  assert.deepEqual(tail.poll().map((e) => e.request_id), ['new', 'newer']);
  assert.deepEqual(tail.poll(), []);
});

test('AuditTail: a missing file is empty, a file created later is read from its start, a truncated file is read again', () => {
  const dir = tmp(); const file = path.join(dir, 'audit.jsonl');
  const tail = new feed.AuditTail(file, { fromEnd: true });
  assert.deepEqual(tail.poll(), []);
  fs.writeFileSync(file, JSON.stringify(entry({ request_id: 'a' })) + '\n' + JSON.stringify(entry({ request_id: 'b' })) + '\n');
  assert.deepEqual(tail.poll().map((e) => e.request_id), ['a', 'b']);
  fs.writeFileSync(file, JSON.stringify(entry({ request_id: 'c' })) + '\n');
  assert.deepEqual(tail.poll().map((e) => e.request_id), ['c']);
});

test('AuditTail.last returns the newest entries of a large file without reading all of it', () => {
  const dir = tmp(); const file = path.join(dir, 'audit.jsonl');
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify(entry({ request_id: 'r' + i })));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const last = feed.AuditTail.last(file, 3);
  assert.deepEqual(last.map((e) => e.request_id), ['r4997', 'r4998', 'r4999']);
  assert.deepEqual(feed.AuditTail.last(path.join(dir, 'missing.jsonl'), 3), []);
});

test('auditPath follows the portal: HERDR_PORTAL_LOG_DIR, else the default under the home directory', () => {
  assert.equal(feed.auditPath({ HERDR_PORTAL_LOG_DIR: '/x/logs' }, '/h'), '/x/logs/audit.jsonl');
  assert.equal(feed.auditPath({}, '/h'), '/h/Library/Logs/herdr-portal/audit.jsonl');
});
