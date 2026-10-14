# API reference

Everything below is read from `lib/actions.js`, `lib/server.js` and `lib/validate.js`; `tests/tooling.test.js` fails if this page and the code disagree about the list of actions.

## Conventions

- Base URL: `http://127.0.0.1:8787` (or your tunnel URL). All `/api/*` calls need `Authorization: Bearer <token>`; see [Security model](security.md).
- Reads are `GET` with query parameters. Writes, `events_reconcile` and `put_file` are `POST` with `Content-Type: application/json` and a body of at most 16 KiB (`put_file`: 2 MiB, see below). A body over the limit gets `413 body_too_large` and the rest of the upload is read and discarded (for at most the 20 s request timeout) so the answer reaches the client instead of a reset. An unknown action is `404 unknown_action`, an action that is off is `404 action_disabled` (today only `agent_decision`, see below), a wrong verb `405`, an unknown parameter `400 unknown_param`.
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
| `GET /`, `/app.js`, `/style.css` | none | the login page and static assets (no Herdr data) |
| `GET /api/health` | token | portal, tunnel probe, Herdr reachability and version, whether writes are enabled, data freshness |
| `GET /api/inventory` | token | every running Herdr session with workspaces, tabs, panes, agents, per-session freshness and gaps |
| `GET /api/ledger` | token | the 50 most recent write results |
| `GET /api/herdr` | token | the action list below (it includes `agent_decision` whether or not it is enabled), `writes_enabled`, `writes_disabled_reason` |

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
| `pane_read` | GET | `session`, `pane_id`, `source?` = `visible` (default) or `detection`, `lines?` 1-500 | Plain-text pane read, truncated to the last 65,536 characters. `recent` and `recent-unwrapped` are refused (`400`) because Herdr may scroll a full-screen agent to produce them |
| `agent_wait` | GET | `session`, `pane_id`, `until?` (list of `idle,working,blocked,done,unknown`), `timeout_ms?` 1000-55000 (default 30000) | Waits for an agent state; at most 8 waits at once |
| `audit_tail` | GET | `n?` 1-500 (default 50) | Last `n` lines of the audit log, oldest first |
| `events_snapshot` | GET | `session?` | The cached inventory with event-stream state |
| `events_reconcile` | POST | `session?` | Forces a fresh `session.snapshot` and returns the inventory |
| `agent_start` | POST (write) | `name` (`[a-z][a-z0-9_-]{0,31}`), `kind` (one of Herdr's documented agent kinds), `startup_timeout_ms?` 3001-300000 | Starts an agent in an existing shell pane. No agent arguments can be passed |
| `agent_prompt` | POST (write) | `text` (at most 8000 chars; not a bare `y`, `n`, `yes`, `no`, `ok`, `enter` or a number of 1-3 digits), `wait_timeout_ms?` 1000-55000, `wait_until?` | Submits a prompt to an `idle` or `done` agent |
| `agent_send_keys` | POST (write) | `keys` (at most 16 of `esc`, `escape`, `ctrl+c`, `up`, `down`, `left`, `right`, `tab`, `shift+tab`, `backspace`) | Non-confirming keys to an agent that is `idle`, `done` or `working` |
| `agent_decision` | POST (write) | `option` (at most 120 chars) | **Off by default** (`404 action_disabled`); the operator can opt in with `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` in the portal's environment. Answers a blocked agent's dialog. See [agent_decision](agent-decision.md) |
| `pane_send_text` | POST (write) | `text` (at most 2000 chars, no control characters) | Literal text, no Enter, to a pane without an agent |
| `pane_send_keys` | POST (write) | `keys` (at most 16; Herdr key syntax) | Keys to a pane without an agent |
| `put_file` | POST (file) | `path`, `content`, `sha256`, `mode?` = `create` (default) or `overwrite`, `action?` = `put_file` | Writes one UTF-8 text file under the drop root and answers with its path, size and sha256 read back from disk. Calls no Herdr method and does not wait on Herdr. See [put_file](#put_file) |
| `pane_run` | POST (write) | `text` (at most 2000 chars, one line, must not start with `-`) | Types a command line plus Enter into a shell pane via `herdr pane run`. **The portal does not run it; the shell in that pane does** |

Which Herdr call each action makes, with the schema pointer and the documentation section it was checked against, is in [proof-matrix.md](proof-matrix.md).

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
| 409 | `no_agent` / `agent_state_not_writable` | an `agent_*` action needs a detected agent in a writable state (`agent_prompt`: `idle`/`done`; `agent_send_keys`: `idle`/`done`/`working`; `unknown` is never writable) |
| 409 | `pane_hosts_agent` | a `pane_*` action or `agent_start` targets a pane that already hosts an agent |
| 502 | `foreground_unknown` | a `pane_*` action cannot determine the pane's foreground process |
| 409 | `foreground_not_shell` | a `pane_*` action targets a pane whose foreground process is not a shell. `pane_send_keys` may still send `esc`, `ctrl+c`, arrows, `tab`, `shift+tab` and `backspace` there, so a stuck program can be interrupted |
| 409 | `idempotency_conflict` | the same key was used with a different payload |
| 502 | `dialog_unreadable` | `agent_decision` (when enabled) cannot read the pane to find the dialog |

Each write re-reads the CLI version and, when it changed, the schema, so upgrading `herdr` needs no portal restart. A session whose server still runs the old build is refused until that server restarts; other sessions are unaffected. The contract check compares request parameter names and required fields only (not types, enums, response fields or meaning), so it cannot tell that a call now means something else, which is why `GET /api/health` reports `contract.verified_live` (true only for the version proven live) and `HERDR_PORTAL_STRICT_VERSION=1` restricts writes to that version. `503 audit_unavailable` / `ledger_unavailable` mean a durable record cannot be written. Nothing is sent in any of these cases. `agent_decision` has its own refusals, listed in [agent_decision](agent-decision.md).

**Result.** `status` is `input_sent` or `agent_started` (HTTP 200), `failed` (422; 403 when `agent_decision` refuses a dialog) or `needs_review` (502). `input_sent` means the input was delivered, never that the task finished. `needs_review` means the outcome is uncertain (timeout, restart between sending and recording): look at the pane before trying again with a *new* key.

**Replay.** The result of a write is stored under its `idempotency_key` in `ledger.jsonl` (fsync'd, survives restarts). Repeating the key returns the stored result with `"replayed": true` and sends nothing.

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
| 503 | `drop_root_missing` / `drop_root_unsafe` / `audit_unavailable` | the root is not a directory owned by the portal user and closed to others, or the audit log cannot be written |
| 500 | `write_failed` / `readback_mismatch` / `readback_failed` | an I/O error, or the file on disk is not what was received (should not happen) |

How it writes: a temp file `.put_file-<random>.tmp` is created in the target's directory (mode 0600, exclusive, never through a symlink), written, `fsync`ed, then published with `rename(2)` (`overwrite`) or `link(2)` (`create`, which cannot replace an existing file even when two requests race). A reader sees the old file, no file, or the new complete file, never a partial one. The file ends up mode 0600. `create` needs a drop root on a filesystem that supports hard links (`link(2)`); on one that does not, `create` answers `500 write_failed` (use `overwrite`, or a different `HERDR_PORTAL_DROP_DIR`). A hard kill of the portal between the temp write and the publish can leave a `.put_file-*.tmp` file behind; it is never visible under a requested name. The directory itself is not `fsync`ed, so after a power loss a just-published file may be absent, never partial.

`put_file` does not touch Herdr, so it is not tied to the Herdr contract check, the pane locks or the ledger, and it keeps answering when Herdr is slow or down. Two calls to the same destination are served one after the other. It does use the audit log (one line per authenticated call, including a body that is too large, not JSON or not UTF-8; `audit_unavailable` when it cannot be written) and the per-client rate limit. Audit lines carry the requested and resolved path, size, hash, result and error code, never the content. It is the one action that writes to the machine's filesystem; see [Security model](security.md).

