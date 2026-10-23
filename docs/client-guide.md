# For an AI assistant that calls the portal

A short path for whoever wires an assistant (such as Instinct) to the portal. [API reference](api.md) has every field; [control.md](control.md) explains reading, scrolling and clicking. The glossary calls whatever holds the token a *caller*.

## 1. Connect

- Base URL: `http://127.0.0.1:8787` on the same machine, or your tunnel's hostname. Every `/api/*` call sends `Authorization: Bearer <token>`.
- Behind Cloudflare Access ([tunnel.md](tunnel.md#access-in-front-of-the-hostname)) a caller must also prove itself to Access. A machine uses a service token: add `CF-Access-Client-Id` and `CF-Access-Client-Secret` to every request, and give the Access policy the **Service Auth** action, or Access answers with a login redirect ([Cloudflare: service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)). Keep the portal's own `Authorization` header as it is.
- Call `GET /api/health` first. `capabilities` tells you what the owner switched on (`history`, `control`, `agent_click`, `tag_panes`), and `herdr.writes_enabled` whether writes can run at all. Plan around what is off; a call to a disabled action is `404 action_disabled`.

## 2. See

- Find panes with `agent_list` and `pane_list` (`session=default` unless the owner uses named sessions). Copy each pane's `terminal_id`: every write needs it.
- **An agent pane:** `pane_read` with `source=recent_unwrapped` for the chat, then `source=visible` for the live screen. Only an `idle` or `done` agent can be paged for history (`409 history_requires_idle` otherwise: read `visible`). Never scroll an agent pane; the portal refuses it (`409 use_history_read`).
- **A plain pane:** `pane_scroll`, then `pane_read` with `source=visible`; with history on for all panes, `recent_unwrapped` returns the shell's scrollback in one call.
- Read `history_mode`, `lines_returned` and `truncated` before you trust a history answer. `409 history_unavailable` carries the visible screen, so nothing is lost.
- A click needs `expect_text`: the text you saw under the cell. If the screen moved, the answer is `409 screen_changed` with the row as it is now.

## 3. Act

- Every write carries `session`, `pane_id`, `expect_terminal_id`, a `request_id` and an `idempotency_key`. **Reuse the same key to retry**: a timeout does not tell you whether the first call arrived, and the portal answers a repeated key with the stored result (`"replayed": true`) without sending twice.
- `agent_prompt` answers `input_sent` (an idle or done agent), `input_sent_queued` (a working agent; the agent's own interface decides whether it queues the text or applies it at once) or `needs_review` (it may have been delivered; look at the pane before you send again).
- **Stop and tell the owner** on `409 blocked_requires_decision`, `409 dialog_on_screen` and `403 escalate_to_owner`: a dialog is waiting, and by default the portal never answers dialogs (an owner can switch on `agent_decision`; check `capabilities`, and answer only what the owner told you to). Do not work around it with keys or clicks.
- `400 invalid_param` for a prompt such as `ok`, `y`, `yes`, `no`, `enter` or a short number: those could answer a dialog, so a prompt must say something.

## 4. Check what you did

- `audit_tail` returns the last lines of the audit log: action, pane, result, HTTP status, error code. It never holds your text.
- With the pane tag on, Herdr's sidebar shows `prompt sent 14:07` beside the agent you just wrote to, and the [plugin](plugin.md) opens a live activity tab.

## What a caller can assume

One token, no scopes: it can do everything that is switched on, on every pane ([security.md](security.md)). Keep it out of prompts and logs.
