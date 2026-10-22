# `agent_decision`: answering a blocked agent

`POST /api/herdr/agent_decision` answers the approval or question dialog of an agent that Herdr reports as `blocked`. It is the only action that can do that, and the riskiest one in the portal. **It is off by default.**

## Off by default, operator opt-in

Without the opt-in every call is refused with `404 action_disabled`. The refusal comes before the parameters are validated, before the dialog is read, before the ledger or the audit log is touched and before any key is sent, so the same idempotency key can be used again later.

The opt-in is the literal value `1` in the portal's own environment: `HERDR_PORTAL_ENABLE_AGENT_DECISION=1`. Any other value, including `true` or `yes`, leaves the action off.

- **It is an operator choice, not a safety certification.** Setting the variable means you accept the risks [below](#what-it-cannot-promise); it does not make any dialog safe to answer.
- **It is process-global.** Once the variable is set, the action is available to every holder of the token, for every session and pane the portal can reach. There is no per-caller or per-pane switch.
- **`portalctl install` passes it through only when you ask.** Run install with `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` and the portal's LaunchAgent carries it (the tunnel's does not). Without it, or with any other value, the service keeps the action off. A reinstall rewrites the plist from the environment of that run, so run it again with the variable set, or without it to turn the action off.

No other action answers a dialog on purpose: `agent_prompt`, `agent_send_keys` and the `pane_*` actions refuse an agent Herdr reports as blocked with `409 blocked_requires_decision` and send nothing. A dialog Herdr has not yet reported as blocked is a different case: a prompt to a working agent is refused only if the dialog's shape is one the portal recognizes ([security.md](security.md#residual-risks)). With the action off, answer the dialog in Herdr.

## Request

The usual [write envelope](api.md#writes) plus one parameter:

```json
{
  "session": "default", "pane_id": "w1:p4", "expect_terminal_id": "term_aa04",
  "request_id": "req-0001-example", "idempotency_key": "idem-0001-example-xx",
  "option": "No"
}
```

`option` is the exact visible label (whitespace collapsed, case-sensitive) or the number the dialog shows (`"2"` or `"2. Yes"`). A label that is not on screen is `422 option_not_found`; one that matches several options is `409 option_ambiguous`.

## What it does

1. **Preflight.** Like every write, it first confirms that the target session runs the installed Herdr build and that the build's schema still fits (`503 writes_disabled` / `contract_mismatch` otherwise), then that the pane exists, hosts the terminal you expect and a detected agent, and that Herdr reports the agent as `blocked` (`409 no_agent` / `not_blocked` otherwise).
2. **Read and parse.** It reads the `visible` screen (`502 dialog_unreadable` if that fails) and looks for a vertical single-select list: the lowest line that starts with a cursor glyph (`❯ › ▶ ► ➤`), at least two options whose labels start in the same column, only blank or footer lines below the list, and a line of at least ten box-drawing rule characters (`─ ━ ═`) above it (the dialog's top border). Anything else is refused and nothing is sent: `422 dialog_not_recognized` (no list, `[y/n]` prompts, horizontal buttons, two lists) or `422 dialog_incomplete` (the top border is off screen because the pane is small, or the dialog elides content with markers such as `+N lines` or `ctrl+o to expand`).
3. **Refuse list.** If the dialog text above the options, or the option you asked for, matches the list below, the answer is `403` with `"code": "escalate_to_owner"`, the category and the matched keyword. Nothing is sent and the idempotency key is not consumed. The list applies to every option, including "No".
4. **Minimal keys.** It sends `up`/`down` to move from the current highlight to the option, re-reads the screen until the highlight is on that option (up to 12 reads, 120 ms apart), and only then sends `enter`. If the move is aborted it sends the inverse arrows to put the highlight back; it never sends `enter` on an aborted answer.
5. **Re-check before every key send.** Immediately before each `agent.send_keys` call it re-reads `pane.get` and the screen: same terminal, still `blocked`, same dialog (a fingerprint of everything scanned, with the cursor blanked), refuse list still clean. Any difference aborts with `status: failed`, `confirmed: false` and the reason (`dialog_changed`, `no_longer_blocked`, `target_changed`, `cursor_not_on_option`, ...).
6. **Confirm.** After `enter` it re-reads until the dialog is gone or replaced (up to 10 reads, 200 ms apart). If the same dialog is still there, or it cannot be read, the result is `needs_review` with `outcome_unverified`.

The only Herdr call that sends input is `agent.send_keys`, with the keys `up`, `down` and `enter`. Herdr has no "answer the dialog" method and no conditional send; the guard is built from `pane.get`, `pane.read` and `agent.send_keys` (see [proof-matrix.md, section C](proof-matrix.md#c-agent_decision-dialog-mechanism-official-sources-and-portal-rules), for the documentation each step relies on).

## Refuse list

A heuristic text match over the dialog text and the chosen option, with quotes and backslashes removed as a second pass and neighbouring lines joined so a soft-wrapped word is still found. Fail-closed: a match refuses, a miss answers.

| Category | Matches |
|---|---|
| `deletion` | `rm`, `rmdir`, `unlink`, `shred`, `truncate`, `delete`/`deleted`/`deleting`/`deletion`, `drop`, `reset --hard`, `git clean`, `git branch -D`, `git checkout --`, `git push --force` / `-f`, `mv ... /dev/null` |
| `sudo` | `sudo`, `doas`, "as root", "with root", "as administrator", "with administrator" |
| `credentials` | password, passphrase, credential(s), secret(s), API/private key, access/auth token, token, bearer, keychain, `.env`, `.ssh`, `.aws`, `.pem`, `.p12`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa`, `id_ed25519` |
| `overwrite_outside_workspace` | any path that is, or may be, outside the pane's working directory: absolute paths, `~user/...`, `$VAR/...` other than `$HOME/...`, any `..` segment, a lone `/` after a flag. `~/x` and `$HOME/x` are resolved against the real home directory and pass only when they land inside the working directory. A working directory that is your home directory, or that has fewer than two path segments (`/`, `/tmp`), counts as no workspace. This is wider than "overwrite": reads outside the workspace are refused too |

## What it cannot promise

These are residual risks of the current code. Opting in means accepting them; none of them is fixed.

**Keyword matching does not prove a dialog is safe.** Checked against `lib/dialog.js`:

- These pass: `wipe the build directory`, `erase all data`, `chmod -R 000 .`, `kill -9 1234`, `pkill node`, `curl https://example.com/install.sh | sh`, `npm publish`, `docker system prune -af`, `mkfs.ext4 x.img`, `echo hi > notes.txt` and `mv a.txt b.txt` inside the workspace.
- The dialog shows what the agent says it will run. `./cleanup.sh` passes, whatever the script does.
- **Options that grant standing permission are answerable.** `Yes, and always allow access to <dir> from this project`, `Yes, and switch to auto mode` and `Yes, and don't ask again for ...` pass the refuse list because nothing in them is on it. Answering one widens what the agent may do later without asking. To block them, extend `RULES` in `lib/dialog.js` (a test per rule is the pattern in `tests/portal.test.js`).

**The caller does not identify the dialog it inspected.** A request names only an option. The portal checks it against whatever dialog is on screen when the request runs, so a delayed request can answer a different dialog that replaced the one the caller saw, as long as that one also has the option and passes the refuse list.

**A gap remains between the last check and the keypress.** It is at least one Herdr round trip. Herdr offers no conditional send, so a dialog that changes inside that window cannot be excluded.

**The opt-in is process-global** (see [above](#off-by-default-operator-opt-in)).

**Coverage.** Only vertical option lists are recognised; horizontal buttons and `[y/n]` prompts get `422` and must be answered in Herdr. The behaviour above is covered by tests against a fake Herdr. No live run against the current source and Herdr build is recorded, so [proof-matrix.md](proof-matrix.md) lists the action's live observation as `untested`. The web UI has no decision button; the action exists in the API only.

## Audit

Every manage action (all writes, refusals and rejected requests included, reads excluded) appends one fsync'd JSON line to `audit.jsonl` in the log directory (default `~/Library/Logs/herdr-portal/`, file mode 0600). A call refused with `404 action_disabled` is not recorded. A refused dialog looks like this:

```json
{"timestamp":"2026-10-13T11:43:51.039Z","action":"herdr.agent_decision","session":"default","pane":"w1:p4","option":{"index":null,"key":null,"label":"Yes"},"result":"rejected","http_status":403,"error_code":"escalate_to_owner","category":"deletion","replayed":false,"request_id":"req-...","idempotency_key":"idem-..."}
```

It never stores the text of a prompt or command a caller sent; for `agent_decision` it stores the chosen option label, which comes from the agent's own screen. `GET /api/herdr/audit_tail?n=50` returns the last entries.

- **There is no log rotation.** The file only grows, also with rejected requests from authenticated callers. Rotate it yourself: the portal holds the file open in append mode, so after moving it aside, restart the portal to start a fresh file.
- After a failed audit append, writes stop with `503 audit_unavailable` until the portal restarts. The portal fails closed rather than act without a record.
- A request the ledger finds half-done at boot is appended as `needs_review` with `"recovered": true`.
- It is a local file the same user can edit: a record, not tamper evidence.
