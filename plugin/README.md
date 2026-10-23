# Instinct Herdr Tunnel: Herdr plugin

Watch what an AI assistant does to your agents through the [Instinct Herdr Tunnel](../README.md) portal, from inside Herdr.

```sh
herdr plugin install romiluz13/instinct-herdr-tunnel/plugin
```

- **Tunnel: show activity** opens a live tab of the portal's recent activity (sent, queued, refused, needs review).
- **Tunnel: show only agents it touched** narrows Herdr's Agents list to the agents the portal sent, or may have sent, input to, **Tunnel: show all agents again** puts it back.
- With `HERDR_PORTAL_TAG_PANES=1` in the portal's environment, each such agent also carries a `$tunnel_last` sidebar token such as `prompt sent 14:07`.

It calls three Herdr socket methods (`agent.view.set`, `agent.view.clear`, `plugin.pane.open`), runs no background process, and cannot send input to a pane. Needs Herdr 0.9.5 or newer and `node` 22 or newer on the Herdr server's `PATH`.

Setup, the sidebar row, key bindings, safety and limits: [docs/plugin.md](../docs/plugin.md).

Independent community project: not affiliated with, endorsed by or sponsored by Instinct or Herdr.
