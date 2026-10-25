# The Herdr plugin and the pane tag

The portal is a doorway into Herdr. These two pieces make the doorway visible from inside Herdr, so you can see what an AI assistant is doing to your agents without opening a log.

- **The pane tag** is set by the portal. Each time it sends, or may have sent, input to a pane, Herdr's sidebar can show `prompt sent 14:07` beside that agent.
- **The plugin** is a small Herdr plugin in [`plugin/`](../plugin). It opens a live activity tab and narrows the Agents list to the agents the portal touched.

Neither one can send anything to a pane. The tag is display metadata, and the plugin has no code path that types into a pane, starts an agent, or closes or stops anything (see [Safety](#safety)).

## Turn the tag on

The tag is off until the owner sets `HERDR_PORTAL_TAG_PANES=1` in the portal's environment (`GET /api/health` shows it as `capabilities.tag_panes`). With the LaunchAgent: `HERDR_PORTAL_TAG_PANES=1 bin/portalctl install`, then `portalctl status`.

When the portal sends input that Herdr accepted (`input_sent`, `input_sent_queued`) or may have accepted (`needs_review`), it makes one best-effort `pane.report_metadata` call on that pane:

| What | Value |
|---|---|
| token | `tunnel_last` |
| text | verb, outcome and local time, such as `prompt sent 14:07`, `prompt queued 14:07`, `run sent 14:07`, `click needs review 14:07` (at most 80 characters, never input text) |
| source | `custom:herdr-tunnel` |
| lifetime | 15 minutes (`ttl_ms`), then Herdr drops it; Herdr does not restore tokens after a server restart |

A refused or failed write is not tagged, and neither is a replay of an earlier write. A tag Herdr refuses or answers slowly changes nothing about the write: the answer to the caller never waits for it.

To see it, add the token to a row of your sidebar in Herdr's `config.toml` (the file Herdr reads its settings from; `herdr config check` validates it), then reload:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$tunnel_last"],
]
```

```sh
herdr config check             # prints "config: ok" for the snippet above
herdr server reload-config
```

## Install the plugin

```sh
herdr plugin install romiluz13/instinct-herdr-tunnel/plugin
```

Herdr clones the repository with `git`, shows a trust preview in an interactive terminal and asks before it registers anything (`--yes` skips the question). It needs Herdr 0.9.5 or newer and `node` 22 or newer on the `PATH` of the Herdr **server** (the plugin's commands run without a shell, as you, in the plugin folder). Update with `herdr plugin update`; remove with `herdr plugin uninstall romiluz13.herdr-tunnel`. The plugin is under 250 lines of JavaScript with no dependencies; read it before you install, because Herdr runs plugins as you and does not sandbox them.

| Action | Does |
|---|---|
| `Tunnel: show activity` (`romiluz13.herdr-tunnel.activity`) | Opens a tab with the portal's recent activity, live. Its header says whether the portal answers and, when `cloudflared` is running on this machine, how many connections the tunnel has: `tunnel up (4 connections)`, or `tunnel DOWN (no connections)`. `q` quits, `p` pauses, arrows and Page keys scroll, End returns to live. Green rows were sent, cyan queued, red refused, yellow need a look |
| `Tunnel: show only agents it touched` (`...agents-touched`) | Sets Herdr's Agents view to the agents that carry a `tunnel_last` tag, newest attention first. It needs no config edit |
| `Tunnel: show all agents again` (`...agents-all`) | Clears that view |

Run them from Herdr's action list, with `herdr plugin action invoke romiluz13.herdr-tunnel.activity`, or bind a key in `config.toml`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "romiluz13.herdr-tunnel.activity"
description = "Tunnel: show activity"
```

The activity tab opens as a normal tab, not as a popup, so it does not take over your keyboard while it is open. The Agents view lasts until you clear it, another plugin sets its own view, this plugin is disabled or uninstalled, or the Herdr server stops. Each use of **Tunnel: show activity** opens another tab; close the old one with `q`.

## Safety

- **No way to send input.** The plugin's socket client refuses every method except `agent.view.set`, `agent.view.clear` and `plugin.pane.open`, and a test checks that no plugin source imports `child_process`, calls the Herdr CLI or names an input method.
- **No secrets.** It never reads the portal's token and never calls the portal's API. The header also asks `cloudflared`'s `/ready` on this machine (`HERDR_PORTAL_TUNNEL_METRICS`, default `127.0.0.1:20241`; only `127.0.0.1` or `localhost` is accepted, and for any other value the default is used without a message). It reads `audit.jsonl`, which holds no prompt text, and the activity tab removes control characters from every field before it draws, so a line in that file cannot move your cursor or recolour your screen.
- **No background process.** Herdr describes plugin startup hooks as one-shot, not as places to keep a daemon, so this plugin has no startup hook. The tag is set by the portal, which is running anyway.
- **Same trust as before.** Anyone who can write `audit.jsonl` is already your user and can drive Herdr directly.

## Limits

- The activity tab reads `audit.jsonl` from `HERDR_PORTAL_LOG_DIR`, else `~/Library/Logs/herdr-portal`, in the environment of the Herdr server. If the portal logs elsewhere, start Herdr with the same variable, or the tab says there is no activity. Its header asks `GET /healthz` on `HERDR_PORTAL_PORT` (default 8787) and shows `portal up` or `portal down`.
- The tunnel part of the header appears only once `cloudflared` has answered `/ready` on the metrics address, so a machine with no tunnel sees none, and another service on that port is ignored. After a connector that had answered stops answering it says `tunnel not answering`.
- Another Herdr plugin, `loofare/herdr-portal`, also reads `HERDR_PORTAL_PORT`. If you run both and set that variable in Herdr's environment, the header's `portal up` check asks the other project's server; leave it unset or run only one.
- The `platforms` list says macOS and Linux because the plugin has no macOS-only code; the portal's own log default is the macOS path, and a real Herdr on Linux was not run.
- Tags are display only. Herdr states that metadata never changes an agent's state, waits or notifications.
- A published Herdr marketplace listing needs the repository topic `herdr-plugin`. This repository has it; that a listing appears has not been checked.

## How it was checked

`tests/plugin-feed.test.js`, `tests/plugin-package.test.js` and `tests/tag-panes.test.js` run in `npm test`. `node scripts/e2e-plugin.js` proves the whole path against a real Herdr in a throwaway home: it links the plugin with no server running, starts a Herdr server and a portal with `HERDR_PORTAL_TAG_PANES=1`, sends a `pane_run` through the portal and reads the tag back from `pane get`, checks that a refused write leaves no tag, sets and clears the Agents view, opens the activity tab through its action and reads it off the screen. It never touches your Herdr or portal. Not covered: how the sidebar row looks in an attached Herdr client (on Herdr 0.9.5 in a throwaway home, `herdr config check` printed `config: ok` for the sidebar row and the key binding above and an error for a misspelled token; nothing draws the row here).
