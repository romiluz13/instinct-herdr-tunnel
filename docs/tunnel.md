# Reaching the portal from another device

**What ships today: a Cloudflare Quick Tunnel.** When the tunnel job is installed, it runs a Quick Tunnel to the loopback port; `portalctl url` prints its address. Cloudflare's [Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) says Quick Tunnels are for testing and development, have no uptime guarantee, get a new hostname on every start, support no Server-Sent Events and allow 200 in-flight requests. Anyone with the URL reaches the portal; only the token stands between them and your agents.

**A named tunnel, yours to set up.** For a stable hostname on a domain in your Cloudflare account, follow Cloudflare's guides to [create a locally-managed tunnel](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/), write its [configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/), [route DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/) to it and [run it as a macOS service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/macos/). With `app.example.com` as a placeholder:

1. `cloudflared tunnel login`, then `cloudflared tunnel create <NAME>`; note the tunnel UUID and the credentials file it prints.
2. In `~/.cloudflared/config.yml` (where the user-level service looks), route the hostname to the portal and end with the required catch-all rule. Check it with `cloudflared tunnel ingress validate`.
   ```yaml
   tunnel: <Tunnel-UUID>
   credentials-file: <path printed by tunnel create>
   ingress:
     - hostname: app.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```
3. `cloudflared tunnel route dns <NAME> app.example.com` creates the CNAME to `<Tunnel-UUID>.cfargotunnel.com`.
4. `cloudflared service install` runs the tunnel at login.
5. Tell the portal the hostname so its `Host` check accepts it. Write `tunnel.json` in the portal's state directory (`HERDR_PORTAL_STATE_DIR`, by default `~/Library/Application Support/herdr-portal/`):
   ```json
   {"mode":"named","hostname":"app.example.com"}
   ```
   then run `portalctl restart portal`. The portal reads this file only at start. The alternative is `HERDR_PORTAL_HOSTS=app.example.com` in the *service's* environment, which means setting it when you run `portalctl install`; setting it in your shell later does not reach a running service.

This file is this project's own metadata: Cloudflare's configuration lives on the tunnel side and offers the portal no way to discover the hostname. Cloudflare's [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/) can add an identity check in front of the hostname; this project neither configures nor tests it. See the next section for why you want one.

### Access in front of the hostname

The bearer token is the only thing between a request and your agents. With history, scroll or click switched on ([control.md](control.md)), a leaked token reads whole chats and clicks inside panes, so do not expose that on a Quick Tunnel, whose address anyone you share it with can reach. Use a named tunnel and put a Cloudflare Access application on its hostname, so a request has to pass Access before the portal is asked for a token. A browser follows the sign-in flow. A script or an AI client cannot, so give it an Access [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/): Cloudflare documents that the client sends it in the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers (use that two-header form: the single-header form would collide with the portal's `Authorization: Bearer`), and the policy action must be Service Auth. The portal's own bearer token still applies behind it, so there are two independent checks. Cloudflare's guide for [agents](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/) covers the same ground. None of this has been run against this portal.

⚠️ **With a cloudflared service, remove the portal's tunnel job.** `bin/tunnel-runner.js` reads the same `tunnel.json` and, in named mode, also expects `"name"` and `"config"`. Without them it cannot start, and launchd restarts it every 10 s. Run `portalctl stop tunnel` and delete its plist (`~/Library/LaunchAgents/<prefix>.tunnel.plist`), or launchd loads it again at the next login. In this setup `portalctl url` prints the hostname from `tunnel.json` while the cloudflared service is loaded (as a LaunchAgent or, with sudo, a LaunchDaemon) and otherwise `public url: none (tunnel not running or URL not yet issued)`; `portalctl revoke` replaces the token but does not stop the cloudflared service, and `/api/health` reports the tunnel only if `HERDR_PORTAL_TUNNEL_METRICS` points at that service's metrics address. None of this setup is tested here.
