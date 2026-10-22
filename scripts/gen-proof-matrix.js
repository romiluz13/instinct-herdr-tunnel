#!/usr/bin/env node
'use strict';
// Builds docs/proof-matrix.md from the code's allowlist and CHECKS each claim against the installed Herdr binary
// (schema, CLI) and Herdr's documentation.
//
// What the file is: evidence. It records (1) a static contract check (method exists in the installed schema, every field the
// portal forwards is a schema field and every field the schema requires is forwarded, documentation headings exist), (2) the
// date of a past live observation, accepted only when the receipt carries the identity of THIS source and Herdr build, and
// (3) which actions the code switches off by default. It never enables or disables anything: the runtime switches are
// `proof.verified` and `gate` in lib/actions.js.
//
// Privacy: the output is assembled from allowlisted fields only (action names, schema names, documentation URLs, versions,
// a calendar date). Receipt notes, screens, pane ids, paths and addresses are never read into it, and a final scan refuses
// to write a document that contains any.
//
//   node scripts/gen-proof-matrix.js            write docs/proof-matrix.md
//   node scripts/gen-proof-matrix.js --check    run every check, print the summary, write nothing
//
// Needs: Herdr installed (HERDR_BIN or `herdr` on PATH) and the docs of that version fetched once with
// `node scripts/fetch-herdr-docs.js --version <installed version>`. Optional receipts: docs/smoke-results.json (scripts/smoke-actions.js) and
// docs/e2e-decision.json (scripts/decision-proof.js).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const receipt = require('./receipt-identity');

const MDX = { 'https://herdr.dev/docs/cli-reference/': 'cli-reference.mdx', 'https://herdr.dev/docs/socket-api/': 'socket-api.mdx', 'https://herdr.dev/docs/agent-automation/': 'agent-automation.mdx' };
const slug = (h) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SCHEMA_SRC = 'herdr api schema --json';

// Text that must never appear in a generated public document.
const FORBIDDEN = [
  ['home or temp path', /\/Users\/|\/home\/[A-Za-z]|\/private\/(?:var|tmp)|\/var\/folders/],
  ['tunnel hostname', /trycloudflare\.com/i],
  ['loopback address', /\b127\.0\.0\.1\b/],
  ['terminal id', /\bterm_[0-9a-f]{4,}\b/],
  ['pane id', /\bw\d+:p\d+\b/],
  ['token-shaped string', /(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}/],
];

function buildReport({ actions, methodOf, schema, herdrVersion, pinned, docsVersion = pinned, portalVersion, readDoc, cliCheck, receipts = {}, identity, generatedAt = new Date().toISOString() }) {
  const oneOf = schema.schemas.request.oneOf;
  const defs = schema.schemas.request.$defs;
  const methods = oneOf.map((v) => v.properties.method.const);
  const defOf = (i) => { const ref = oneOf[i].properties.params.$ref; const name = ref ? ref.split('/').pop() : null; return { name, def: name && defs[name] ? defs[name] : { properties: {}, required: [] } }; };
  const docSection = (file, heading) => {
    const body = readDoc(file); if (body == null) return null;
    const m = new RegExp(`^#{2,3} ${reEsc(heading)}\\s*$`, 'm').exec(body); if (!m) return null;
    const rest = body.slice(m.index + m[0].length); const nx = /^#{2,3} /m.exec(rest);
    return (nx ? rest.slice(0, nx.index) : rest).replace(/\s+/g, ' ');
  };
  const docCheck = (url, section) => {
    const f = MDX[url]; if (!f) return { ok: false, text: `${url}#${slug(section)} (no local copy)` };
    const ok = docSection(f, section) !== null;
    return { ok, text: `${url}#${slug(section)}` + (ok ? '' : ' (HEADING NOT FOUND)') };
  };

  // A receipt counts as current evidence only for this exact source and Herdr build.
  const liveFor = (name) => {
    for (const src of [receipts.smoke, receipts.decision]) {
      const r = src && src.results && src.results[name]; if (!r) continue;
      const date = receipt.dateOnly(r.at);
      if (!date) return 'untested';
      if (!receipt.same(src.identity, identity)) return 'untested (receipt is for another source or Herdr build)';
      return `${r.ok ? 'PASS' : 'FAIL'} ${date}`;
    }
    return 'untested';
  };

  let contractFails = 0;
  const rows = [];
  for (const [name, a] of Object.entries(actions)) {
    const p = a.proof; const checks = []; let native = '';
    if (p.sock) {
      const i = methods.indexOf(p.sock);
      checks.push(i >= 0);
      if (i >= 0) {
        const { name: defName, def } = defOf(i);
        const props = Object.keys(def.properties || {}); const req = def.required || [];
        const fw = p.forwards; const sent = fw ? [...(fw.required || []), ...(fw.optional || [])] : [];
        const unknown = sent.filter((x) => !props.includes(x));
        const missing = req.filter((x) => !(fw && (fw.required || []).includes(x)));
        const fwOk = !!fw && unknown.length === 0 && missing.length === 0; checks.push(fwOk);
        native = `socket \`${p.sock}\`<br>\`${SCHEMA_SRC}\` \`/schemas/request/oneOf/${i}\` → \`/schemas/request/$defs/${defName}\`<br>schema params: ${props.map((x) => '`' + x + '`').join(', ') || '(none)'}; required: ${req.map((x) => '`' + x + '`').join(', ') || '(none)'}<br>`
          + (fwOk ? `forwarded: ${sent.map((x) => '`' + x + '`').join(', ') || '(none)'} (all are schema fields; every required field is sent)`
            : `**FORWARDED PARAMETERS DO NOT MATCH THE SCHEMA**${!fw ? ' (not declared)' : ''}${unknown.length ? ` not in schema: ${unknown.map((x) => '`' + x + '`').join(', ')}` : ''}${missing.length ? ` required but not sent: ${missing.map((x) => '`' + x + '`').join(', ')}` : ''}`);
      } else native = `socket \`${p.sock}\`<br>**NOT IN SCHEMA**`;
    } else if (p.cli) {
      const c = cliCheck(p.cli); checks.push(c.ok);
      const other = p.cli[1] === 'run' ? 'pane.run' : p.cli[0] === 'session' ? 'session.list' : null; // the socket method a CLI command could be mistaken for
      native = `CLI \`herdr ${p.cli.join(' ')}\`<br>${c.text}` + (other ? `<br>not a socket method: \`${other}\` ${methods.includes(other) ? 'EXISTS' : 'absent from schema'}` : '');
    } else if (p.portal) {
      const usesOk = (p.uses || []).every((m) => methods.includes(m)); checks.push(usesOk);
      native = (p.uses || []).length ? `portal operation (not a Herdr method); built from ${p.uses.map((m) => `\`${m}\` (/schemas/request/oneOf/${methods.indexOf(m)})`).join(', ')}` : `portal operation (not a Herdr method, makes no Herdr call): ${p.native || 'reads the portal\'s own `audit.jsonl`'}`;
    }
    if (p.sock || p.cli) for (const u of p.uses || []) { // further Herdr methods the action calls (re-check before sending)
      const j = methods.indexOf(u); checks.push(j >= 0);
      native += `<br>also calls \`${u}\` ${j >= 0 ? `(/schemas/request/oneOf/${j} → \`${defOf(j).name}\`)` : '**NOT IN SCHEMA**'}`;
    }
    const docs = (p.docs || []).map(([u, s]) => { const c = docCheck(u, s); checks.push(c.ok); return c.text; });
    const contractOk = checks.every(Boolean); if (!contractOk) contractFails += 1;
    const live = liveFor(name);
    const gate = p.verified === false ? `off by default${a.optInEnv ? `; operator opt-in: \`${a.optInEnv}=1\`` : ''}` : a.gate ? `off by default; owner switch: \`${a.gate}=1\`` : 'on';
    const input = Object.keys(a.params).map((k) => '`' + k + '`').join(', ');
    rows.push({ name, live, contractOk, line: `| \`${name}\` | ${methodOf(name)} | ${native} | ${input} | ${docs.join('<br>')} | ${contractOk ? 'pass' : '**FAIL**'} | ${live} | ${gate} |` });
  }

  const notEnabled = [
    ['`agent_decision` (answering a blocked agent\'s dialog)', 'off by default. Answering a trust, permission or auto-mode dialog is the owner\'s decision; the caller names an option, not the dialog it looked at, and the refuse list is a keyword heuristic, not proof of safety. An operator can opt in with `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` and accepts those risks'],
    ['`session.list` socket method', methods.includes('session.list') ? 'present' : 'absent from installed schema; `session_list` uses CLI `session list --json` (CLI ref > Sessions)'],
    ['`pane.run` socket method', methods.includes('pane.run') ? 'present' : 'absent; `pane_run` uses CLI `pane run`'],
    ['`agent.send_text`', methods.includes('agent.send_text') ? 'present' : 'absent; not implemented (pane_send_text only for panes without an agent)'],
    ['`pane.read` with source `recent` / `recent_unwrapped`', 'exists in schema (ReadSource enum); history reads, off unless the owner sets HERDR_PORTAL_ENABLE_HISTORY (403 source_disabled otherwise): an idle recognized agent is paged through its own scroll interface (Agent automation > Alternate-screen history reads), so only idle or done agents are read'],
    ['Answering a blocked dialog through any action other than `agent_decision`', 'not possible while Herdr reports the agent as blocked: `agent_prompt`, `agent_send_keys`, `pane_*` all refuse it with 409 `blocked_requires_decision`. A dialog Herdr has not yet reported as blocked is only caught if its shape is one the portal recognizes (a working agent\'s prompt reads the screen first)'],
    ['`agent_decision` on dialogs that are not a vertical single-select list with a cursor (horizontal buttons, free text, `[y/n]` prompts)', 'refused with 422 `dialog_not_recognized`; nothing is sent'],
    ['`agent.start` native `args`', 'not exposed (no permission-bypass flags)'],
    ['takeover/attach/control, focus, rename, layout, view, close/stop, worktree, server-control, plugin methods', 'not in allowlist; unreachable (404 unknown_action)'],
  ];

  const internal = [
    ['ping', 'liveness/version of each session socket; every write pings its own target again after taking the pane lock and refuses a server whose version or protocol differs from the installed CLI whose schema was checked', 'Socket transport'],
    ['session.snapshot', 'inventory bootstrap and reconcile', 'Raw methods'],
    ['events.subscribe', 'invalidation stream (lifecycle subscriptions only; ack `subscription_started` awaited before the snapshot that may clear the stale flag)', 'Event subscriptions'],
    ['pane.get', 'write preflight: target identity (`terminal_id`), agent presence and status; `agent_decision` re-reads it right before each key send', 'Raw methods'],
    ['pane.read', 'write preflight: visible + detection text returned with a blocked refusal; `agent_decision` reads `visible` to find and re-check the dialog (same two sources only)', 'Reading panes'],
    ['pane.process_info', 'write preflight for pane_*: foreground process must be a shell (CLI `herdr pane process-info`)', 'Raw methods'],
  ];
  const internalRows = internal.map(([m, why, sec]) => {
    const i = methods.indexOf(m); const d = docCheck('https://herdr.dev/docs/socket-api/', sec);
    const ok = i >= 0 && d.ok; if (!ok) contractFails += 1;
    return `| \`${m}\` | ${why} | \`/schemas/request/oneOf/${i}\` → \`${i >= 0 ? defOf(i).name : ''}\` | ${d.text} | ${ok ? 'found' : '**FAIL**'} |`;
  });

  // ---- C. dialog mechanism: official statements and portal rules. Documents the mechanism for operators who opt in; says nothing about safety. ----
  const DIALOG = [
    ['An agent waiting on an approval or question UI reports `blocked`', 'https://herdr.dev/docs/agent-automation/', 'agent-automation.mdx', 'Choose the control surface', '`blocked` means Herdr recognized an approval or question UI.', 'agent_decision runs only when `pane.get` says `agent_status: blocked`, and again right before every key send'],
    ['A blocked agent is answered with `agent send-keys`, after inspecting the dialog', 'https://herdr.dev/docs/agent-automation/', 'agent-automation.mdx', 'Choose the control surface', 'inspect the dialog and use `agent send-keys` for a deliberate response', 'the only key-sending call in agent_decision is `agent.send_keys` (target = hosting pane id); the dialog is read first with `pane.read` source `visible`'],
    ['`agent send-keys` takes logical keys; all keys are validated before any byte is written', 'https://herdr.dev/docs/cli-reference/', 'cli-reference.mdx', 'Agents', 'sends logical terminal keys such as `enter`, `up`, `esc`, or `ctrl+c`. Herdr validates every key before writing any bytes', 'keys used: `up`, `down`, `enter` only (named keys; one call for the moves, a separate call for `enter`)'],
    ['`agent.send_keys` is a socket method; key strings follow the Herdr key-combo syntax (named keys such as `enter`)', 'https://herdr.dev/docs/socket-api/', 'socket-api.mdx', 'Raw methods', 'accept Herdr key-combo strings: plain printable keys, special keys like `enter` and `esc`', 'the syntax sentence is written for `pane.send_keys`; `agent.send_keys` has the same `keys: string[]` schema and the CLI reference names `enter`/`up` for it'],
    ['`visible` is the current rendered screen (what the dialog looks like to the user)', 'https://herdr.dev/docs/cli-reference/', 'cli-reference.mdx', 'Read sources', '| `visible` | Current rendered screen. Best for UI feedback loops. |', 'only `visible` is used to find the options; `recent`/`recent-unwrapped` stay refused'],
  ];
  const dialogRows = DIALOG.map(([claim, url, file, heading, needle, rule]) => {
    const sec = docSection(file, heading); const ok = !!sec && sec.includes(needle.replace(/\s+/g, ' '));
    if (!ok) contractFails += 1;
    return `| ${claim} | ${url}#${slug(heading)} (\`docs/official/${file}\`) | ${ok ? 'heading and sentence found' : '**NOT FOUND**'} | ${rule} |`;
  });
  const dialogRules = [
    ['Dialog recognised only as a vertical single-select list: the LOWEST line starting with a cursor glyph (`❯ › ▶ ► ➤`; ASCII `>` deliberately excluded, it starts quoted prose), >= 2 options with labels in one column (wrapped labels are joined), numbered options (`1. Yes`) supported, only blank/footer lines below the list, one list per frame. Anything else: 422 `dialog_not_recognized`', 'portal rule; two Claude Code dialogs were examined by hand, other agents\' dialogs are not covered', '`tests/portal.test.js` "dialog parser: stale lists, prompts below…", "dialog helpers"'],
    ['A solid `─` rule above the options (the dialog\'s top border) must be visible, else 422 `dialog_incomplete` (a small pane clips the dialog). A dialog that elides content ("+N lines", "ctrl+o to expand", "(truncated)") is refused the same way', 'portal rule, found on a very small pane: a dialog was answered although its text was off screen', '"agent_decision refuses a dialog whose top is clipped…"'],
    ['`option` = exact visible label (whitespace-collapsed, case-sensitive) or the number shown; no match 422 `option_not_found`, several matches 409 `option_ambiguous`', 'portal rule', '"agent_decision: refuses anything that is not a recognised dialog…"'],
    ['Minimal keys: `up`/`down` x distance (no wrap), verified by re-reading the screen until the cursor is on the option, then `enter`. `enter` is never sent before that verification. If the move is aborted the cursor is put back with the inverse arrow keys (never Enter)', 'portal rule (Herdr has no atomic "send if still blocked")', '"…re-checks right before sending" (highlight that never arrives: no Enter; cursor restored)'],
    ['Re-check before each send: same terminal, still `blocked`, same dialog fingerprint (hash of everything scanned, cursor blanked, blinking status marker normalised), refuse list clean. Any change aborts with `failed` and `confirmed:false`. The caller does not present the fingerprint it inspected, so a request that arrives late is checked against whatever dialog is showing then', 'portal rule; residual window is one Herdr round trip between the last read and the send', '"…re-checks right before sending" (changed dialog, unblocked agent); "dialog scan: a rule printed inside the command…"'],
    ['Refuse list (403 `escalate_to_owner`, nothing sent, no idempotency key consumed), scanned over the screen from the topmost rule above the options to the footer, plus the requested option, for every option including "No": deletion, `sudo`/`doas`/"as root", credentials, and any path outside the pane\'s working directory. Also scanned with quotes/backslashes removed and with neighbouring lines joined (soft wrap). Heuristic text match, fail-closed. It does not recognise a trust, persistent-permission or auto-mode dialog as such, and it is not proof a dialog is safe', 'portal rule', '"agent_decision refuse list…", "refuse list: redirects, variables…" (benign commands pass)'],
    ['After `enter`: re-read until the dialog is gone or replaced; still showing or unreadable -> `needs_review` `outcome_unverified`', 'portal rule', '"…re-checks right before sending" (unverified outcome)'],
    ['Audit: one fsync\'d JSON line per manage action (also refusals and rejected requests) in `audit.jsonl` in the log directory (mode 0600): timestamp, action, session, pane, option (`{index,key,label}` or null), result, http_status, error_code, category, replayed, request_id, idempotency_key. No text of prompts or commands the caller sent; the chosen dialog option label is recorded. A request the ledger finds half-done at boot is appended as `needs_review` (`recovered:true`). `audit_tail` returns the last N (1-500). The file is never rotated', 'portal rule', '"audit log: one durable line per manage action…", "…audit shape and multibyte tail"'],
  ];

  const withLive = rows.filter((r) => r.live.startsWith('PASS')).length;
  const markdown = `# Proof matrix — Herdr portal ${portalVersion}

Generated ${generatedAt.slice(0, 10)} by \`scripts/gen-proof-matrix.js\`. Installed Herdr: **${herdrVersion}** (last proven live: ${pinned}; at run time every write is judged against the installed CLI's own schema, see lib/compat.js). Schema: output of \`${SCHEMA_SRC}\` — **${methods.length}** request methods (\`/schemas/request/oneOf\`, protocol ${schema.protocol}).

**What this file is.** Evidence, not a switch. It enables and disables nothing: the runtime switches are \`proof.verified\` and \`gate\` in \`lib/actions.js\`, shown in the last column, and the live contract check in \`lib/compat.js\`, which applies the same \`forwards\` declarations to whatever Herdr is installed when the portal runs. Three different kinds of evidence are kept apart:

- **Contract (static):** the native method exists in the installed schema, every field the portal forwards is a schema field, every field the schema requires is forwarded, and the cited documentation headings exist. This proves names, not that a forwarded value is valid, what the response means or that anything executed.
- **Live observation (historical):** the date of a past run of \`scripts/smoke-actions.js\` / \`scripts/decision-proof.js\` against a real Herdr. A receipt counts only when it carries the identity (source hash, Herdr version, protocol) of this source and Herdr build; otherwise the cell says \`untested\`. No receipt notes are copied into this file.
- **Local fake tests:** \`npm test\` runs the allowlist against a fake Herdr; those results are not recorded here.

Doc headings and sentences are checked against the raw v${docsVersion} source of the three Herdr pages named below (fetched by \`scripts/fetch-herdr-docs.js\`; https://herdr.dev/llms.txt lists the raw sources per release); the human URLs below are the same pages. Schema pointers and CLI commands are checked against the installed binary.

## A. Allowlisted actions (wrapper → native Herdr operation)

| Wrapper | HTTP | Native command/method + schema pointer | Portal input (strict, unknown keys rejected) | Official URL + section | Contract | Live observation | Gate in code |
|---|---|---|---|---|---|---|---|
${rows.map((r) => r.line).join('\n')}

Rows A-total: ${rows.length}; contract failures: ${rows.filter((r) => !r.contractOk).length}; rows with a current PASS receipt: ${withLive}.

## B. Requested/possible things that are NOT enabled

| Item | Status |
|---|---|
${notEnabled.map(([a, b]) => `| ${a} | ${b} |`).join('\n')}

## B2. Herdr calls the portal makes internally (not exposed as actions)

| Method | Purpose | Schema pointer | Official URL + section | Check |
|---|---|---|---|---|
${internalRows.join('\n')}

## C. agent_decision: dialog mechanism (official sources) and portal rules

\`agent_decision\` is off by default. This section documents how it works for an operator who opts in; it is not a statement that answering dialogs is safe, and it does not describe any trust, permission or auto-mode dialog as something to answer. Official statements it relies on were looked up in the saved v${pinned} source, inside the named section.

| Claim | Official URL + section | Check | How the portal uses it |
|---|---|---|---|
${dialogRows.join('\n')}

Portal rules (ours, not Herdr functions). Herdr exposes no "answer dialog" method and no conditional send; the guard is built from \`pane.get\`, \`pane.read\` and \`agent.send_keys\`.

| Rule | Basis | Test |
|---|---|---|
${dialogRules.map(([a, b, c]) => `| ${a} | ${b} | ${c} |`).join('\n')}

Overall: ${contractFails === 0 ? 'ALL CONTRACT CHECKS PASSED' : contractFails + ' CONTRACT CHECK(S) FAILED'}
`;
  const leaks = FORBIDDEN.filter(([, re]) => re.test(markdown)).map(([label]) => label);
  return { markdown, contractFails, rows, leaks };
}

function main() {
  const { ACTIONS, methodOf } = require('../lib/actions');
  const { config, PINNED_HERDR_VERSION } = require('../lib/config');
  const check = process.argv.includes('--check');
  const D = path.join(__dirname, '..', 'docs');
  const readDoc = (f) => { try { return fs.readFileSync(path.join(D, 'official', f), 'utf8'); } catch { return null; } };
  if (['cli-reference', 'socket-api', 'agent-automation'].some((n) => readDoc(`${n}.mdx`) === null)) { console.error('missing docs/official/*.mdx; run: node scripts/fetch-herdr-docs.js'); process.exit(2); }
  const schema = JSON.parse(execFileSync(config.herdrBin, ['api', 'schema', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const herdrVersion = execFileSync(config.herdrBin, ['--version'], { encoding: 'utf8' }).trim().replace(/^herdr\s+/, '');
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')); } catch { return null; } };
  const cliCheck = (cmd) => {
    try {
      const out = execFileSync(config.herdrBin, [...cmd, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: out.includes(`herdr ${cmd.join(' ')}`) || out.includes('Usage'), text: `\`herdr ${cmd.join(' ')} --help\` exit 0 (${herdrVersion})` };
    } catch { // `session` has no --help for list; group listing prints usage and exits 0
      try { const out = execFileSync(config.herdrBin, [cmd[0]], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return { ok: out.includes(`herdr ${cmd.join(' ')}`), text: `\`herdr ${cmd[0]}\` usage lists \`herdr ${cmd.join(' ')}\`` }; } catch { return { ok: false, text: 'CLI command not found' }; }
    }
  };
  const docsVersion = readDoc('VERSION'); const r = buildReport({ actions: ACTIONS, methodOf, schema, herdrVersion, pinned: PINNED_HERDR_VERSION, docsVersion: docsVersion ? docsVersion.trim() : PINNED_HERDR_VERSION, portalVersion: config.version, readDoc, cliCheck, receipts: { smoke: readJson('smoke-results.json'), decision: readJson('e2e-decision.json') }, identity: receipt.make({ herdrVersion, protocol: schema.protocol }) });
  if (r.leaks.length) { console.error(`refusing: the generated document would contain: ${r.leaks.join(', ')}`); process.exit(3); }
  if (!check) fs.writeFileSync(path.join(D, 'proof-matrix.md'), r.markdown);
  console.log(`${check ? 'checked (nothing written)' : 'wrote docs/proof-matrix.md'}; ${r.rows.length} actions; contract failures: ${r.contractFails}; rows with a current PASS receipt: ${r.rows.filter((x) => x.live.startsWith('PASS')).length}`);
  process.exit(r.contractFails ? 1 : 0);
}

if (require.main === module) main();
module.exports = { buildReport, FORBIDDEN };
