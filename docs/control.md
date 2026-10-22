# Seeing, scrolling and clicking: the control model

A pane's visible screen is small. A caller such as Instinct (an AI), or a phone, needs the whole chat, a way to move the view, and sometimes a click. Each of these is **off until the owner turns it on**, and each goes through the allowlist and the bearer token. A scroll or a click also goes through the ledger and the audit log like every other write; a history read leaves an audit line but no ledger row.

| Capability | Switch (portal environment) | Off means |
|---|---|---|
| History reads | `HERDR_PORTAL_ENABLE_HISTORY` = `agents` (or `1`), or `all` | `pane_read` with `source=recent` or `recent_unwrapped` is `403 source_disabled` |
| Scroll and click | `HERDR_PORTAL_ENABLE_CONTROL=1` | `pane_scroll` and `pane_click` are `404 action_disabled` |
| Click on a pane that hosts an agent | `HERDR_PORTAL_ENABLE_AGENT_CLICK=1` (counts only while control is on) | `409 agent_click_disabled` |

Any other value of a switch leaves the feature off. A value that is not accepted (for history: not `1`, `agents`, `all`, `0` or empty; for the other two: not `1`, `0` or empty) is logged at start-up (`gate_invalid`) and shows as `invalid` in `GET /api/health` under `capabilities`, so a typo is never silently on or off. `portalctl install` warns about such a value and does not pass it to the service.

## Two loops for a caller

- **Agent pane.** `pane_read` with `source=recent_unwrapped` for the chat (the last 1000 rows or so: Herdr 0.9.5 returns no more for an agent, and `truncated: true` says when the chat was longer; a read took 0.01 s to 11 s on idle agents in a live check), `source=visible` for the live screen. Do not scroll an agent pane: it is refused (`use_history_read`), because a scrolled agent stops answering history reads.
- **Plain pane.** `pane_scroll`, then `pane_read` with `source=visible`. With history on for all panes, `recent_unwrapped` reads the shell's scrollback in one call.

Every history answer says how complete it is (`history_mode`: `agent_scrollback`, `host_scrollback`, `screen_only` or `unknown`) with `lines_returned` and `truncated`. "Nothing beyond the screen" is a typed answer (`409 history_unavailable`, with the screen attached), never an empty success.

## Scroll

- **Herdr has scrollback for the pane** (`pane_get` shows `scroll.max_offset_from_bottom` above 0): the portal sets an absolute offset through the socket (3 lines per step, clamped; `bottom` is offset 0). The answer says `host_scrollback` with `scroll_before` and `scroll_after`. The pane **stays scrolled for its owner** until it is moved back.
- **No Herdr scrollback** (a full-screen app on the alternate screen, or a shell that has not scrolled): the portal sends wheel events through a terminal controller, one per step. The answer says `wheel_events` and claims no position, because what a wheel event does is the app's business. `bottom` has no meaning there (`422 bottom_unsupported`).

## Click

A click is bound to what the caller saw. The caller names a cell (`column`, `row`, counted from 0) **and the text under it** (`expect_text`, at least two non-blank characters). The portal reads the screen once, right before delivery, and sends the click only if that text is on that row and covers that column. Otherwise nothing is sent and the answer carries the row as it is now (`409 screen_changed`).

It also refuses, with nothing sent:

- **Rows it cannot map.** A column is a terminal cell; the portal reads text by code point. Wide (CJK, fullwidth), combining, zero-width (including format characters such as U+FEFF and U+202E, and conjoining Hangul jamo), pictographic and non-BMP characters at or before the text break that mapping, so such rows are `422 row_not_cell_mappable`. Box drawing, `…` and `●` count as one cell. Claude Code rows that start with `⏺` (U+23FA) are therefore not clickable to the right of the marker.
- **Rows that look like a choice, and confirm or refuse words.** The expected text, or any word on the clicked row, being allow, approve, accept, yes, trust, always, deny, reject, no, proceed, continue, confirm, ok, y or n as a whole word; a row that looks like a menu entry, which is judged on the clicked row and the two rows above and below it, over its first 1000 cells and after a box border such as `│` is dropped: it starts with an option number or letter, a cursor, or a check, radio or ballot box (`1.`, `1:`, `(1)`, `a)`, `[1]`, `[ ]`, `❯`, `→`, `◉`, `○`, `☐`), or it holds two buttons with a space or a bar between them (`[ Run ]   [ Skip ]`, `[Run] [Skip]`, `( Run ) ( Skip )`, `[ Run ] | [ Cancel`; the second button may be cut off), or two rows within the window are each a single button; a row matching the refuse list used for `agent_decision` (deleting, `sudo`, credentials, paths outside the working directory); or any screen where a dialog is recognized (`dialog_on_screen`). These are `403 escalate_to_owner` or `409 dialog_on_screen`. The window errs toward refusing: a line next to an input prompt that starts with `>` or `›`, a log line such as `[12:00:01] [INFO]`, and a `(venv) (base)` prompt are refused too, and `matched` in the answer says which pattern fired.
- **What these checks are not.** They are pattern matching, not an understanding of the program. A menu drawn in a shape none of these patterns knows can still be clicked, so with the control switch on a caller can click anything the patterns miss. That is the reason control is its own switch, off by default, and why the Cloudflare Access advice in [tunnel.md](tunnel.md) comes before turning it on.
- **A busy agent.** On a pane that hosts an agent, clicks need the third switch and an `idle` or `done` agent. A working agent can raise a permission dialog between the screen read and the click; that residual is listed in [security.md](security.md).

The clicked text is never written to the ledger or the audit log. The ledger keeps a hash of the whole request; the audit line keeps the button and the cell.

## The terminal controller

Clicks and wheel scrolls use Herdr's documented terminal-control stream, one short-lived process per action: `herdr terminal session control`, started with an argument array and a clean environment.

- **No takeover, no resize.** The portal never evicts a controller someone else holds (`409 controller_busy`) and never asks for a resize. A controller attached at the pane's exact size changes nothing; at a wrong size Herdr would resize the owner's terminal and restore it about a second later, which re-renders their agent. So the portal first reads the pane's **real** size from its tty (the tty from process info, else `ps` on the shell's pid, cross-checked with the foreground process) and requires its rows to equal the pane's viewport rows. If it cannot confirm the size: `409 size_unverified`, nothing sent. After the call the size is read again; a change is `needs_review` with `resized: true` (`resized: "unknown"` when the size cannot be read afterwards).
- **Outcome by the order of records, not by wording.** Closed before any frame with a reason that says the attach failed (Herdr 0.9.5 words it "terminal attach failed: … already has an attached client"): nothing was delivered (`controller_busy` or `controller_refused`, both definite). Closed before any frame for any other reason: `needs_review`, because the commands may have been consumed. Closed with reason `detached` and exit 0: delivered. Herdr sends a frame only when the screen changes, so an app that ignores a wheel event produces none. Anything else after the commands were written is `needs_review`: look at the pane before you retry.
- **Delivered is not acted on.** `input_sent` means Herdr accepted the events. Herdr drops a mouse event when the application has not enabled mouse reporting, so a click on a plain shell reports success and does nothing.
- **Limits.** 5 seconds of life (`SIGTERM`, then `SIGKILL` 1 second later, on the exact pid), at most 4 at once (`429 too_many_controllers`), the pane lock held until the child has closed, or at the latest 1.5 s after the kill grace ends. A controller stopped at its deadline is `needs_review` with "a mouse button may still be pressed".

## Not covered

Said plainly, because these were not measured:

- **The owner typing while a controller is attached.** A click or wheel event may interleave with their keystrokes; this was not measured (the harness could not drive Herdr's own terminal UI).
- **Linux.** The size lookup uses `ps` and `stty -F` there; only the macOS path (`stty -f`) was run.
- **Whether a program acts on a click or a wheel event.** The tests and the live proof show what the portal delivers and what a small app receives; how a real agent or full-screen app reacts was not measured.
- **History of a pane Herdr has not classified.** With `HERDR_PORTAL_ENABLE_HISTORY=all` a plain pane is read passively; whether Herdr pages a full-screen app that it has not yet recognized as an agent was not measured.
- **Herdr's own documentation of the scroll calls.** `pane.scroll` (socket) and `terminal.scroll` (controller) are not described in Herdr's prose docs; their shapes come from the installed schema and from `scripts/e2e-control.js`, which exercises both against a real Herdr.
- **Herdr paging a real recognized agent.** The live proof uses a reported (fake) agent on its main screen. The agent branch that pages a full-screen agent through Herdr's own scroll interface, and its 30-second timeout on a slow agent, were exercised against fakes only. In the live run the reported agent's pane had Herdr scrollback, so the answer was `host_scrollback`; `agent_scrollback` appeared only in tests against the fake.
- **Assistive technology.** The browser view has a single status line and no live region on terminal text; no screen reader was run.
- **Browsers.** The page's behavior is tested in a small DOM against a real portal. Its layout, a wheel gesture, a touch tap on a cell, the click and scroll buttons and the content security policy were checked once, by a throwaway script that is not in this repository, in headless Chrome 156 on macOS at 390×844 and 1280×800 with a fake Herdr behind a real portal. Other browsers, other sizes, a real Herdr behind the page and a person using it were not.

## The live proof

`node scripts/e2e-control.js` starts its own Herdr server and portal in a fresh temporary home (it checks that its session is the only one running before it sends anything, and stops both by exact pid), then runs: a plain shell's history and host-scrollback scroll, pane to bottom, a wheel scroll and an exact-size click against a small app that turns mouse reporting on (asserting the exact bytes the app received and that nothing was resized), the stale-screen and wrong-terminal refusals, a reported agent's history and its scroll/click refusals, shapes of the socket calls this relies on, and the existing `scripts/e2e.js` write round trip. The portal is started detached, with no controlling terminal. It skips with exit 0 when `herdr` is not installed.

## Suggested switches

History for agents only (`HERDR_PORTAL_ENABLE_HISTORY=agents`) is the least a caller needs to read a chat. Turn control on only when the portal is behind something that authenticates people before the token is even asked for (see [tunnel.md](tunnel.md)). Leave agent click off unless you have decided that a click on an idle agent is worth the residual risk.

Under launchd, `portalctl install` copies each switch into the portal's LaunchAgent only when you set it, with a value the portal understands, at install time, and, when a portal job was already loaded, proves that the new instance reports exactly those capabilities in `GET /api/health` (a fresh install is not health-checked, see [configuration.md](configuration.md)). The plist is rewritten on every install, so a switch you leave out of a later install is off again:

```sh
HERDR_PORTAL_ENABLE_HISTORY=agents bin/portalctl install
```
