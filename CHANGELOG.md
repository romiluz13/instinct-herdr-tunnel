# Changelog

All notable changes. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is alpha; the first release is 0.1.0, and the Herdr plugin in `plugin/` carries the same number.

## [Unreleased]

## [0.1.1] - 2026-10-25

### Added

- **`portalctl diagnose`.** A read-only report for a public address that stops answering: whether the portal answers and how many connections the tunnel has, the last request the portal handled and the last audit entry, and the outages in the last 24 hours (no tunnel connection to Cloudflare), each with its first error, plus the default network and sleep events on macOS. It reads no token and prints no URL or tunnel hostname. `HERDR_PORTAL_TUNNEL_LOG` names the log to read. See [docs/tunnel.md](docs/tunnel.md).

### Changed

- The plugin's activity tab shows the tunnel in its header (`tunnel up (4 connections)`, `tunnel DOWN (no connections)`, `tunnel not answering`), read from `cloudflared`'s `/ready` on this machine.
- Documentation: a public `302` does not show the tunnel is up.
- Documentation: the README is rebuilt as a landing page, with a banner drawn in code, a macOS quickstart built on `portalctl install` and a recording of `scripts/e2e-control.js`. The real outputs it used to carry moved to [docs/see-it-work.md](docs/see-it-work.md); the images are in `docs/img/`.
- Documentation: the glossary's audit log entry now covers history reads and says a call to a switched-off action leaves no line.
- The docs test also checks that every repository path a document names exists, that no Markdown file states a wrong number of actions, and that the README's count of Herdr request methods matches the proof matrix.

### Not proven

As in 0.1.0, and also a real `launchctl` bootstrap, a real `cloudflared`, and a named tunnel with Cloudflare Access: the README's quickstart was run against a stub `launchctl` and a disposable Herdr, not the real services.

## [0.1.0] - 2026-10-24

### Added

- **Pane tag.** With `HERDR_PORTAL_TAG_PANES=1` the portal sets a display-only Herdr pane tag (`tunnel_last`, text such as `prompt sent 14:07`) on each pane it sent, or may have sent, input to, best effort and never delayed by Herdr. `capabilities.tag_panes` in health, a fourth switch `portalctl install` copies. See [docs/plugin.md](docs/plugin.md).
- **Herdr plugin** in `plugin/` (`herdr plugin install romiluz13/instinct-herdr-tunnel/plugin`): a live activity tab read from the audit log, and actions that narrow Herdr's Agents list to the agents the portal touched and put it back. It calls three socket methods and has no way to send input or keep a process running.
- **`scripts/e2e-plugin.js`.** A live proof of the tag and the plugin on a real Herdr in a throwaway home.
- [docs/client-guide.md](docs/client-guide.md), a path for an AI assistant: connect (with Cloudflare Access service-token headers), see, act, check.
- **History reads.** `pane_read` with `source=recent` or `recent_unwrapped` returns up to 2000 lines (262,144 characters) of a plain pane's scrollback, or the last 1000 rows of an idle agent's chat (the most Herdr 0.9.5 returns for an agent), with `history_mode`, `lines_returned` and `truncated`. Each read leaves an audit line (pane, source, size, never text). Off until `HERDR_PORTAL_ENABLE_HISTORY` is `agents` (or `1`) or `all`. A pane with nothing beyond its screen answers `409 history_unavailable` with the screen attached.
- **`pane_scroll`.** Scrolls a pane that does not host an agent: through Herdr's own scrollback by absolute offset where the pane has some, otherwise as wheel events through a terminal controller (refused while a dialog is on the screen). Off until `HERDR_PORTAL_ENABLE_CONTROL=1`.
- **`pane_click`.** Clicks one cell, only if the text the caller expects is still under it; refuses rows that look like a dialog choice or hold a confirm or refuse word (pattern matching, not a guarantee), rows it cannot map to a cell, and a pane whose real size it cannot confirm. Off until `HERDR_PORTAL_ENABLE_CONTROL=1`; on a pane that hosts an agent it also needs `HERDR_PORTAL_ENABLE_AGENT_CLICK=1`.
- **Capabilities in health.** `GET /api/health` shows the effective `capabilities` (`history`, `control`, `agent_click`, `tag_panes`); a mistyped value of any of the four switches reads `invalid` and is logged at start, and `portalctl install` warns about it.
- **Browser page.** A live view of the selected pane that keeps its place while it updates, History and Detection modes with *Load more*, scroll buttons and a click mode. The output box has a fixed height (60% of the window, 18 to 60 rem), so rows that wrap above it cannot shift what it shows; on a screen under 1000 px wide, choosing a pane scrolls to it.
- **`scripts/e2e-control.js`.** A live proof on a real Herdr in a throwaway home; 19 steps passed on Herdr 0.9.5.
- **`portalctl install`** copies the three new switches into the portal's LaunchAgent when set at install time and proves that the new instance reports them.
- A test that every relative link and anchor in the Markdown files resolves and that the README states the real number of actions and the pinned Herdr version.
- Documentation: [control.md](docs/control.md), a Cloudflare Access recommendation in [tunnel.md](docs/tunnel.md), the [glossary](GLOSSARY.md), a code of conduct, issue and pull request templates, and a CI workflow for Node 22, 24 and 26.

### Changed

- **`agent_prompt` accepts a `working` agent.** It answers `input_sent_queued` (HTTP 200) with a `note`: the prompt was submitted, and the agent's own interface decides whether it queues it or applies it at once. A `blocked` or `unknown` agent is still refused with a typed 409 and nothing is sent (Herdr itself rejects a prompt for a blocked agent), and a working agent whose screen shows a recognized dialog is refused with `409 dialog_on_screen`; an unreadable screen is `502 screen_unreadable`. `agent_decision` stays off and no approve or deny action was added.
- The version proven live moved from Herdr 0.9.3 to 0.9.5 (`HERDR_PORTAL_STRICT_VERSION=1` now restricts writes to 0.9.5). The proof matrix was regenerated against 0.9.5.
- The proof matrix lists the socket methods that CLI-based actions also call.
- `portalctl status` and `portalctl url` also find a cloudflared service installed without `sudo` (a LaunchAgent), not only one installed with it (a LaunchDaemon).
- A controller that closes before any frame without saying the attach failed is `needs_review`, not a definite failure: the commands may have been consumed.
- The time the pane-size read waits for `ps` or `stty` is `HERDR_PORTAL_SIZE_TOOL_TIMEOUT_MS` (default 3000); the tests raise it so a loaded machine does not time out the fakes.
- `size_unverified` errors say why `ps` or `stty` failed (timed out, exit code).
- The portal's 8 KiB request header limit is set through the documented `http.createServer` option instead of by assigning to the server afterwards; a test pins the `431` answer.
- `scripts/e2e.js` prints `SKIP`, not `PASS`, for a refusal check it leaves out on purpose.
- The click guard judges the clicked row and the two rows above and below it, over its first 1000 cells and after a box border is dropped. It also refuses cursor rows (`❯`, `>`, `◉`, `○`), `a)`, `[1]` and `1:` options, ballot boxes, buttons with a space or a bar between them or in parentheses (the second may be cut off), and two single-button rows. It is still pattern matching, and it refuses some ordinary screens next to an input prompt or a log line.
- Zero-width format characters (U+FEFF, U+202E, U+00AD and the rest of the `Cf` class) and conjoining Hangul jamo make a row `row_not_cell_mappable`.
- A history read is refused with `503 audit_unavailable` when the audit log cannot be written, as a write is; the read that first finds the log unwritable is not returned.
- A timeout setting that is not a whole number of milliseconds (`1.5`, `-5`, `Infinity`) falls back to its default instead of failing every click and scroll.
- A controller close is a definite attach failure only when its reason opens with "terminal attach failed" or "attach failed".
- An agent-click value other than `1`, `0` or empty (such as `false`) leaves agent clicks off; a guard that tested the value for truthiness had let it through.
- The test harness stops a portal that failed to start instead of leaving it, picks another port when a parallel test file took the same one, and the page tests wait longer for a slow machine.

### Not proven

A recognized agent paged by Herdr in a script (it was read once by hand on live claude, codex and droid agents), the owner typing while a click is delivered, a real Herdr on Linux (CI runs the suite there against fakes), assistive technology, and the page beyond one headless Chrome 156 run. See [control.md](docs/control.md#not-covered).
