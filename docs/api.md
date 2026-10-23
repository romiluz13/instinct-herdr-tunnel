# API reference

Everything below is read from `lib/actions.js`, `lib/server.js` and `lib/validate.js`; `tests/tooling.test.js` fails if this page and the code disagree about the list of actions.

## Conventions

- Base URL: `http://127.0.0.1:8787` (or your tunnel URL). All `/api/*` calls need `Authorization: Bearer <token>`; see [Security model](security.md).
- Reads are `GET` with query parameters. Writes, `events_reconcile` and `put_file` are `POST` with `Content-Type: application/json` and a body of at most 16 KiB (`put_file`: 2 MiB, see below). A body over the limit gets `413 body_too_large` and the rest of the upload is read and discarded (until Node's request timeout of 20 s is noticed, which it checks every 30 s by default, so up to about 30 s) so the answer reaches the client instead of a reset. An unknown action is `404 unknown_action`, an action that is off is `404 action_disabled` (`agent_decision`, `pane_scroll` and `pane_click` until the owner switches them on, see below), a wrong verb `405`, an unknown parameter `400 unknown_param`.
- Errors: `{"ok": false, "error": {"code": "...", "message": "...", ...}}`; `put_file` answers `{"ok": false, "error": "<code>", "detail": "..."}` instead.
- Rate limits per client: 240 requests per minute (`429 rate_limited`) and 8 failed authentications per 5 minutes (`429`).
- `session` is a Herdr session name (`default` unless you use named sessions). Pane ids look like `w1:p2`, terminal ids like `term_ab12…`.

```sh
TOKEN=$(cat "${HERDR_PORTAL_STATE_DIR:-$HOME/Library/Application Support/herdr-portal}/secrets/portal-token")
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/herdr/agent_list?session=default"
```

## Other endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /healthz` | none | `{"portal":"up"}` and nothing else |
| `GET /`, `/index.html`, `/app.js`, `/viewer.js`, `/style.css` | none | the login page and static assets (no Herdr data) |
| `GET /api/health` | token | portal, tunnel probe, Herdr reachability and version, whether writes are enabled, `capabilities` (the effective history, control, agent-click and pane-tag switches), data freshness, and `build`: `code_sha256` (server.js and every `lib/*.js`, read when the process started), `static_sha256` (the public files held in memory and served), a random `instance_id` and `started_at` per process, and `flags` (`strict_version`, `agent_decision`) as this process applies them. A browser tab can still run an older `app.js` it loaded before a restart; reload it after an upgrade. Limits: these are content checksums the process reports about itself, not an attestation (anyone who can edit the files can make a process report anything); a file changed between being loaded and being hashed at start is not detected; they cover neither `node_modules`, the Node binary nor the Herdr binary |
| `GET /api/inventory` | token | every running Herdr session with workspaces, tabs, panes, agents, per-session freshness and gaps |
| `GET /api/ledger` | token | the 50 most recent write results |
| `GET /api/herdr` | token | the action list below (it includes `agent_decision`, `pane_scroll` and `pane_click` whether or not they are enabled), `writes_enabled`, `writes_disabled_reason` |

## Actions

`GET /api/herdr/<action>` for reads, `POST /api/herdr/<action>` for the rest. `?` marks an optional parameter.

| Action | Verb | Parameters | What it does |
|---|---|---|---|
| `ping` | GET | `session?` | Round trip to each session's socket: version, protocol, latency |
| `session_list` | GET | | Sessions found by `herdr session list --json` |
| `session_snapshot` | GET | `session` | Herdr's `session.snapshot` |
| `workspace_list` / `workspace_get` | GET | `session`; `workspace_id` | Workspaces |
| `tab_list` / `tab_get` | GET | `session`, `workspace_id?`; `tab_id` | Tabs |
| `pane_list` / `pane_get` | GET | `session`, `workspace_id?`; `pane_id` | Panes |
| `agent_list` / `agent_get` | GET | `session`; `pane_id` | Agents (`agent_get` targets the hosting pane id) |
| `pane_read` | GET | `session`, `pane_id`, `source?` = `visible` (default), `detection`, `recent` or `recent_unwrapped`, `lines?` 1-500 (1-2000 for the history sources), `expect_terminal_id?` | Plain-text pane read. `visible` and `detection` are truncated to the last 65,536 characters. `recent` and `recent_unwrapped` are history reads: off unless the owner enabled them, see "History reads" below. With `expect_terminal_id` the portal first runs `pane.get` and answers `409 target_changed` without reading if the pane hosts another terminal; a matching answer carries `checked_terminal_id`. Herdr's read result does not name the terminal, so a terminal replaced between the check and the read is still read: this is a precheck, not a terminal-bound read |
| `agent_wait` | GET | `session`, `pane_id`, `until?` (list of `idle,working,blocked,done,unknown`), `timeout_ms?` 1000-55000 (default 30000) | Waits for an agent state; at most 8 waits at once |
| `audit_tail` | GET | `n?` 1-500 (default 50) | Last `n` lines of the audit log, oldest first |
| `events_snapshot` | GET | `session?` | The cached inventory with event-stream state |
| `events_reconcile` | POST | `session?` | Forces a fresh `session.snapshot` and returns the inventory |
| `agent_start` | POST (write) | `name` (`[a-z][a-z0-9_-]{0,31}`), `kind` (one of Herdr's documented agent kinds), `startup_timeout_ms?` 3001-300000 | Starts an agent in an existing shell pane. No agent arguments can be passed |
| `agent_prompt` | POST (write) | `text` (at most 8000 chars; not a bare `y`, `n`, `yes`, `no`, `ok`, `enter` or a number of 1-3 digits), `wait_timeout_ms?` 1000-55000, `wait_until?` | Submits a prompt to an `idle`, `done` or `working` agent. A working agent answers `input_sent_queued`; a `blocked` or `unknown` agent is refused |
| `agent_send_keys` | POST (write) | `keys` (at most 16 of `esc`, `escape`, `ctrl+c`, `up`, `down`, `left`, `right`, `tab`, `shift+tab`, `backspace`) | Non-confirming keys to an agent that is `idle`, `done` or `working` |
| `agent_decision` | POST (write) | `option` (at most 120 chars) | **Off by default** (`404 action_disabled`); the owner can opt in with `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` in the portal's environment. Answers a blocked agent's dialog. See [agent_decision](agent-decision.md) |
| `pane_send_text` | POST (write) | `text` (at most 2000 chars, no control characters) | Literal text, no Enter, to a pane without an agent |
| `pane_send_keys` | POST (write) | `keys` (at most 16; Herdr key syntax) | Keys to a pane without an agent |
| `put_file` | POST (file) | `path`, `content`, `sha256`, `mode?` = `create` (default) or `overwrite`, `action?` = `put_file` | Writes one UTF-8 text file under the drop root and answers with its path, size and sha256 read back from disk. Calls no Herdr method and does not wait on Herdr. See [put_file](#put_file) |
| `pane_run` | POST (write) | `text` (at most 2000 chars, one line, must not start with `-`) | Types a command line plus Enter into a shell pane via `herdr pane run`. **The portal does not run it; the shell in that pane does** |
| `pane_scroll` | POST (write) | `direction` (`up`, `down` or `bottom`), `steps?` 1-50 (default 1; ignored for `bottom`) | **Off by default** (`404 action_disabled`); the owner can opt in with `HERDR_PORTAL_ENABLE_CONTROL=1`. Scrolls a pane that hosts no recognized agent. See "Scrolling" below |
| `pane_click` | POST (write) | `column`, `row` (0-based cells), `button?` = `left` (default) or `right`, `expect_text` (2-120 characters, at least 2 not blank) | **Off by default** (`404 action_disabled`); the owner can opt in with `HERDR_PORTAL_ENABLE_CONTROL=1`. Clicks one cell, only if `expect_text` is still under it. See "Clicking" below |

Which Herdr call each action makes, with the schema pointer and the documentation section it was checked against, is in [proof-matrix.md](proof-matrix.md).

### History reads

`source=recent_unwrapped` (joined lines) or `source=recent` (as wrapped on screen) returns more than the visible screen, up to 2000 lines and 262,144 characters (the last 262,144 if more). For an agent pane Herdr 0.9.5 returns at most about 1000 rows whatever `lines` asks for (live check: 1100, 1500 and 2000 all returned 998 lines, with `truncated: true`), so an agent's earlier chat is out of reach and `truncated` says so. History reads are off until the owner sets `HERDR_PORTAL_ENABLE_HISTORY` in the portal's environment; `/api/health` shows the effective value under `capabilities.history`.

- `agents` (or `1`): only panes that host a recognized agent. `all`: every pane, including plain shells, whose scrollback can hold keys and tokens. Any other value turns history off, is logged at startup and shows as `invalid` in health. A refused read is `403 source_disabled` and names the variable.
- A recognized agent is read only when its `agent_status` is `idle` or `done`. Herdr pages such an agent through its own scroll interface and returns it to the bottom; a working, blocked or unknown agent is refused with `409 history_requires_idle` (the error carries `agent_status`). Read `visible` instead.
- Every history answer carries `history_mode`: `agent_scrollback` (a recognized agent returned more lines than its screen holds), `host_scrollback` (Herdr's own scrollback of the pane has lines beyond the screen) or `screen_only` (nothing beyond the screen). It also carries `lines_requested`, `lines_returned` and `truncated`. When Herdr gives no scroll metrics the mode is `unknown` and nothing is refused on a guess. `lines` defaults to 500.
- `screen_only` with `lines` above the screen height is `409 history_unavailable`: the pane has no history beyond its screen. The error carries `visible_text` (the screen), `viewport_rows` and `history_mode`, so nothing is lost. A short chat of a fresh agent is the common case; treat it as a normal answer, not a failure.
- Every history read, answered or refused, leaves one audit line: `action: herdr.pane_read`, session, pane, `source`, `history` (`mode`, `lines_requested`, `lines_returned`, `truncated`) and the result. Never the text. A `visible` or `detection` read leaves none, and a request refused before it is dispatched (for example a duplicate parameter) leaves none either. When the audit log cannot be written, a history read is refused with `503 audit_unavailable` and nothing is returned, including the read that first finds the log unwritable (the pane was read, the text is dropped), as for writes until the portal restarts.
- History reads of an agent pane take the pane's lock, so one runs at a time and a write waits behind it. They have their own timeout of 30 s (`HERDR_PORTAL_HISTORY_TIMEOUT_MS`); a timeout is `504 history_timeout` ("the agent may still be scrolling; read visible before retrying"). Plain-pane reads are passive and take no lock.

### Scrolling

`pane_scroll` is off until the owner sets `HERDR_PORTAL_ENABLE_CONTROL=1`; `/api/health` shows it under `capabilities.control`. It is a write: it takes the same envelope as the other writes (`request_id`, `idempotency_key`, `expect_terminal_id`) and goes through the ledger, the audit log and the pane lock. The audit line records the direction, the steps and the path, never pane text.

- A recognized agent pane is refused with `409 use_history_read`: scrolling it would stop Herdr from reading its history. Read it with `source=recent_unwrapped`. A pane whose agent status is `unknown` is refused with `409 agent_state_not_writable`.
- A pane with Herdr scrollback (`max_offset_from_bottom` above 0 in `pane_get`) is moved through the socket's `pane.scroll` by absolute offset: 3 lines per step, clamped to the scrollback, `bottom` is offset 0. The answer has `delivered_as: "host_scrollback"` with `scroll_before` and `scroll_after` (`offset_from_bottom`, `max_offset_from_bottom`). The pane stays scrolled for its owner until it is moved back; the answer says so. No controller is started and the terminal size is not touched. A Herdr whose schema lacks `pane.scroll` is refused up front by the compatibility check (`503 contract_mismatch`); one that lists it but answers that the method is unknown gives `422 scroll_unsupported`. Either way nothing is sent and the wheel path is not used as a fallback.
- A pane with no Herdr scrollback (a full-screen app on the alternate screen, or a shell that has not scrolled yet) gets wheel events through a terminal controller, one `terminal.scroll` of 3 lines per step. The answer has `delivered_as: "wheel_events"` and no position: an app decides what a wheel event does. `bottom` has no meaning there and is `422 bottom_unsupported`; scroll down or read `visible`. Before anything is sent the portal reads the terminal's real size and refuses with `409 size_unverified` if it cannot confirm it; it never resizes the terminal and never takes over a controller someone else holds (`409 controller_busy`). At most 4 controllers run at once (`429 too_many_controllers`). If such a pane shows a dialog the call is `409 dialog_on_screen` and nothing is sent: an app that turns a wheel notch into an arrow key would move the highlight the owner is about to confirm.
- A controller that does not finish within 5 s (`HERDR_PORTAL_CONTROLLER_LIFETIME_MS`) is stopped, and the result is `needs_review`: look at the pane before you retry. The same is true when the terminal's size changed during the call (`resized: true`).

### Clicking

`pane_click` shares the switch, the write envelope and the controller rules of `pane_scroll`. It is bound to what the caller saw: `expect_text` must still be on the row, covering the clicked column. The portal reads the screen once, right before delivery, and compares the raw row; the text is never written to the ledger or the audit log (the ledger keeps a hash of the whole request, the audit line keeps the button and the cell).

- `409 screen_changed`: the text is not under that cell any more. The error carries `row` and `row_text`, so the caller can decide again.
- `422 row_not_cell_mappable`: the row holds a wide (CJK, fullwidth), combining, zero-width (including format characters such as U+FEFF and U+202E, and conjoining Hangul jamo) or pictographic character, or any character outside the first plane, at or before the end of the text. A column cannot be mapped to the text safely there, so nothing is sent. Box drawing, `…` and `●` count as one cell. Claude Code rows that start with `⏺` are not clickable to the right of it.
- `403 escalate_to_owner`: the text, or the word under the click, or any word on the clicked row, is a confirm or refuse word (allow, approve, accept, yes, trust, always, deny, reject, no, proceed, continue, confirm, ok, y, n), the row matches the dialog refuse list (deleting, sudo, credentials, a path outside the working directory), or the clicked row, or a row within two rows of it, looks like a menu choice (it starts, after a box border, with an option number or letter, a cursor or a check, radio or ballot box, or holds two buttons with a space or a bar between them, the second possibly cut off; two rows within that window that are each a single button count too; `category: "dialog_choice"`). The window refuses some ordinary screens, such as a line beside an input prompt that starts with `>` or `›`; `matched` says which pattern fired. These are patterns, not an understanding of the program; see [control.md](control.md#click).
- `409 dialog_on_screen`: the pane shows a dialog the portal recognizes; nothing is clicked while one is open.
- `422 out_of_bounds`: the cell is outside the terminal; the error carries `rows` and `cols`.
- A pane that hosts an agent is `409 agent_click_disabled` unless the owner also sets `HERDR_PORTAL_ENABLE_AGENT_CLICK=1` (it counts only while control is on; health shows `capabilities.agent_click`), and then only for an `idle` or `done` agent (`409 agent_state_not_writable` otherwise, `409 blocked_requires_decision` for a blocked one).
- The answer is `delivered_as: "mouse_click"` with the button and the cell. Whether the app reacts is the app's business: an app that has not asked for mouse reports ignores the click.

Two loops for a caller such as Instinct. On an agent pane: read history (`recent_unwrapped`) for the whole chat and `visible` for the live screen. On a plain pane: `pane_scroll`, then read `visible`.

## Writes

Every write needs `session`, `pane_id`, `expect_terminal_id` (copy it from the inventory so a pane that was reused is detected), `request_id` (8-128 characters of `A-Za-z0-9._-`) and `idempotency_key` (16-128 characters of the same set) plus the action's own parameters. Writes to the same pane run one at a time; when its turn comes, each write pings its target session and re-reads the pane. The portal refuses, before sending anything, when:

| HTTP | Code | Meaning |
|---|---|---|
| 503 | `writes_disabled` | the installed `herdr` CLI cannot run or its schema cannot be read; or the target session's running server reports a version or protocol other than the installed CLI's (checked per write, per session); or `HERDR_PORTAL_STRICT_VERSION=1` and the installed version is not the one proven live |
| 503 | `contract_mismatch` | the installed Herdr's schema no longer fits what this action sends (a method or CLI subcommand is gone, a sent field is no longer accepted, or a new required field exists). Only that action is refused; `GET /api/health` lists it under `herdr.contract.failing_actions` |
| 502 | `herdr_<code>` | the target session cannot be pinged, or the pane cannot be read |
| 404 | `target_not_found` | the pane does not exist |
| 409 | `target_ambiguous` | Herdr answered for a different pane id than the one requested |
| 409 | `target_changed` | the pane now hosts another terminal |
| 409 | `blocked_requires_decision` | the agent is `blocked`; the error carries the visible text and the parsed options. Answer it in Herdr (`agent_decision` is off by default) |
| 409 | `no_agent` / `agent_state_not_writable` | an `agent_*` action needs a detected agent in a writable state (`agent_prompt`: `idle`/`done`/`working`; `agent_send_keys`: `idle`/`done`/`working`; `unknown` is never writable) |
| 409 | `dialog_on_screen` | `pane_scroll`, `pane_click`, or `agent_prompt` to a `working` agent: the pane shows a dialog the portal recognizes, and the input could answer it, so nothing is sent. Answer it in Herdr |
| 502 | `screen_unreadable` | the same three actions could not read the pane's screen to rule a dialog out; nothing is sent |
| 409 | `pane_hosts_agent` | a `pane_*` action or `agent_start` targets a pane that already hosts an agent |
| 502 | `foreground_unknown` | a `pane_*` action cannot determine the pane's foreground process |
| 409 | `foreground_not_shell` | a `pane_*` action targets a pane whose foreground process is not a shell. `pane_send_keys` may still send `esc`, `ctrl+c`, arrows, `tab`, `shift+tab` and `backspace` there, so a stuck program can be interrupted |
| 409 | `idempotency_conflict` | the same key was used with a different payload |
| 502 | `dialog_unreadable` | `agent_decision` (when enabled) cannot read the pane to find the dialog |

Each write re-reads the CLI version and, when it changed, the schema, so upgrading `herdr` needs no portal restart. A session whose server still runs the old build is refused until that server restarts; other sessions are unaffected. The contract check compares request parameter names and required fields only (not types, enums, response fields or meaning), so it cannot tell that a call now means something else, which is why `GET /api/health` reports `contract.verified_live` (true only for the version proven live) and `HERDR_PORTAL_STRICT_VERSION=1` restricts writes to that version. `503 audit_unavailable` / `ledger_unavailable` mean a durable record cannot be written. Nothing is sent in any of these cases. `agent_decision` has its own refusals, listed in [agent_decision](agent-decision.md).

**Result.** `status` is `input_sent`, `input_sent_queued` or `agent_started` (HTTP 200), `failed` or `needs_review` (502). A `failed` result is 422 by default; `agent_decision` refusing a dialog is 403, `controller_busy` 409, `too_many_controllers` 429, and `controller_refused` or `controller_unavailable` 502. `input_sent` means the input was delivered, never that the task finished. `input_sent_queued` is `agent_prompt` to an agent whose status was `working`: the prompt was submitted, and the agent's own interface decides whether it queues it or applies it at once, which the portal cannot see; the result carries a `note` saying so. A `wait_timeout_ms` on such a prompt can end with the turn that was already running, because Herdr does not track individual turns. If Herdr finds the agent blocked after all, `agent_prompt` answers `failed` with `detail.error` `agent_blocked`, with or without a wait: Herdr sent nothing. `needs_review` means the outcome is uncertain (timeout, restart between sending and recording): look at the pane before trying again with a *new* key.

**Replay.** The result of a write is stored under its `idempotency_key` in `ledger.jsonl` (fsync'd, survives restarts). Repeating the key returns the stored result with `"replayed": true` and sends nothing. A request found half-done at boot (sent or maybe sent, result not recorded) is finalized as `needs_review` with `recovered_at` and `finished_at: null`; its outcome time is unknown.

**Intent and audit.** Each new write gets an `intent_id` (in the answer, the ledger rows and its audit line). The ledger row says the audit line is owed; once the line is written an ack follows. If the audit line cannot be written the answer carries `"audit": "deferred"`, and the next portal start writes it from the ledger (`reconciled: true`) without sending anything again. A crash after the line but before its ack writes it once more at the next start, so audit lines are at least once: de-duplicate by `intent_id` and `result`. A half-done (pending) row written by an older version is still finalized as `needs_review` and audited once, as before; completed rows from older versions are never turned into audit lines or rewritten.

## put_file

`POST /api/herdr/put_file` writes one UTF-8 text file into the **drop root** and tells you what is on disk afterwards. The drop root is `HERDR_PORTAL_DROP_DIR`, by default `inbox/` inside the state directory; it is created with mode 0700 if missing. Nothing outside it can be written, and the action neither runs nor interprets the content.

```sh
BODY='{"path":"notes/today.md","content":"hello\n","sha256":"'$(printf 'hello\n' | shasum -a 256 | cut -d' ' -f1)'"}'
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" http://127.0.0.1:8787/api/herdr/put_file
# {"ok":true,"path":"<drop root>/notes/today.md","bytes":6,"sha256":"5891b5b5...","mode_used":"create"}
```

| Field | Rule |
|---|---|
| `path` | Relative to the drop root, or absolute and inside it. Components use only `A-Z a-z 0-9 . _ -`, may not start with a dot, and may not be empty, `.` or `..` (so `%2e%2e` and a NUL byte are refused too); at most 1024 characters and 16 levels, and short enough that the drop root plus the path plus the temp name stay under 1024 bytes (`path_invalid`, before anything is created). Missing subdirectories are created with mode 0700 |
| `content` | Valid UTF-8 text, at most 262,144 bytes once encoded. A lone surrogate, or bytes that are not UTF-8 in the request body, are refused; nothing is replaced |
| `sha256` | Hex (any case) of the UTF-8 bytes of `content`. Checked before anything on disk is touched |
| `mode` | `create` (default) fails with `409 exists` if the file is there; `overwrite` replaces it atomically |
| `action` | Optional; if present it must be `put_file` |

Success: `{"ok": true, "path": "<absolute resolved path>", "bytes": N, "sha256": "<hex>", "mode_used": "create|overwrite"}`. `path`, `bytes` and `sha256` come from re-reading the file from disk after it was published, not from the request. Failure: `{"ok": false, "error": "<code>", "detail": "..."}` and nothing is written.

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `path_invalid` | empty, too long, NUL byte, `.`/`..`/empty component, or a character outside the allowed set |
| 400 | `content_not_utf8` / `sha256_invalid` / `bad_json` / `invalid_param` / `missing_param` / `unknown_param` | the body is not UTF-8 or not a JSON object, or a field is missing, unknown or of the wrong type |
| 403 | `path_outside_root` | an absolute path that is not inside the drop root |
| 403 | `symlink_refused` | any component, or the target, is a symbolic link, or a directory resolves outside the root |
| 409 | `exists` / `is_directory` / `not_a_directory` / `not_regular_file` | the destination does not allow this write |
| 413 | `content_too_large` | more than 262,144 bytes of content |
| 413 | `body_too_large` | request body over 2 MiB (262,144 bytes of content can need up to 1.5 MiB as JSON `\u` escapes) |
| 422 | `sha256_mismatch` | the hash does not match the received bytes; `detail` carries the hash that was computed |
| 503 | `drop_root_missing` / `drop_root_unsafe` / `audit_unavailable` / `ledger_unavailable` | the root is not a directory owned by the portal user and closed to others, or the audit log or the ledger cannot be written; nothing was written (`audit_unavailable` also refuses every write action and every history read) |
| 500 | `write_failed` | an I/O error before the file was published; an existing file is unchanged and the call can be retried |
| 500 | `committed_unverified` | the file was published under the requested name, then the read-back failed. The body adds `committed: true`, `verified: false` (the outcome as a whole is unverified; with `ledger_unrecorded` the read-back matched, and `observed_*` show it), `retryable: false`, `reason` (`readback_mismatch`, `readback_failed`, `symlink_refused`, `write_failed`, or `ledger_unrecorded` when the file was written and read back but its outcome could not be recorded), `path`, `intent_id`, and `sha256`/`bytes`: the hash and size of what this call received and wrote, not of what is on disk. When the read-back got as far as reading the file, `observed_sha256`/`observed_bytes` say what it found there. The file is left as it is: inspect it (size, hash, mode) before writing again; a blind retry writes it a second time, and `create` will answer `exists`. HTTP clients and proxies may retry any 5xx: read the body, never conclude from a 5xx that nothing was written |

A refusal found after the intent was recorded (for example `exists` or `symlink_refused` at publish time, or `write_failed`) adds the intent's `intent_id`, and `audit: "deferred"` if its audit line is still owed.

How it writes: a temp file `.put_file-<random>.tmp` is created in the target's directory (mode 0600, exclusive, never through a symlink), written, `fsync`ed, then published with `rename(2)` (`overwrite`) or `link(2)` (`create`, which cannot replace an existing file even when two requests race). A reader sees the old file, no file, or the new complete file, never a partial one. The file ends up mode 0600. `create` needs a drop root on a filesystem that supports hard links (`link(2)`); on one that does not, `create` answers `500 write_failed` (use `overwrite`, or a different `HERDR_PORTAL_DROP_DIR`). A hard kill of the portal between the temp write and the publish can leave a `.put_file-*.tmp` file behind; it is never visible under a requested name. The directory itself is not `fsync`ed, so after a power loss a just-published file may be absent, never partial.

`put_file` does not touch Herdr, so it is not tied to the Herdr contract check or the pane locks, and it keeps answering when Herdr is slow or down. It records an intent row in the ledger (sizes and hashes, never content) just before the first change on disk and an outcome row after; a call without a recorded outcome is finalized at the next start as `needs_review` (with what `lstat` sees at the path, never a re-write). A success answer carries `intent_id`, and `"audit": "deferred"` when its audit line is still owed. Two calls to the same destination are served one after the other. It does use the audit log (one line per authenticated call, including a body that is too large, not JSON or not UTF-8; `audit_unavailable` when it cannot be written) and the per-client rate limit. Audit lines carry the requested and resolved path, size, hash, result and error code, never the content. It is the one action that writes to the machine's filesystem; see [Security model](security.md).

