# Configuration and running as a service

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_PORTAL_PORT` | `8787` | Loopback port (the host is always `127.0.0.1`) |
| `HERDR_PORTAL_STATE_DIR` | `~/Library/Application Support/herdr-portal` | Token (`secrets/portal-token`), `ledger.jsonl`, `tunnel.json`, `tunnel-url.txt` |
| `HERDR_PORTAL_LOG_DIR` | `~/Library/Logs/herdr-portal` | `audit.jsonl` and the service logs |
| `HERDR_BIN` | `herdr` on `PATH` | The Herdr CLI. Under launchd set an absolute path; if `herdr` is a version-manager shim, point at the real binary |
| `HERDR_PORTAL_DROP_DIR` | `<state dir>/inbox` | The only directory `put_file` writes to. Created with mode 0700 if missing; an existing one is not chmod'ed and must be owned by the portal user and not writable by others. It must support hard links (`create` mode uses `link(2)`) |
| `HERDR_PORTAL_HOSTS` | none | Extra allowed `Host` names, comma separated |
| `HERDR_PORTAL_TUNNEL_METRICS` | `127.0.0.1:20241` | Where `cloudflared` serves its metrics; the portal probes it for `/api/health` |
| `CLOUDFLARED_BIN` | `cloudflared` on `PATH` | The tunnel binary |
| `HERDR_PORTAL_LAUNCHD_PREFIX` | `dev.herdr-portal` | launchd label of the portal (the tunnel adds `.tunnel`) |
| `HERDR_PORTAL_STRICT_VERSION` | unset (off) | `1` limits writes to the Herdr version proven live (0.9.3); otherwise any version whose schema fits is accepted. `portalctl install` copies it into the portal LaunchAgent (not the tunnel's) only when set to `1` at install time |
| `HERDR_PORTAL_ENABLE_AGENT_DECISION` | unset (off) | `1` enables `agent_decision`; any other value leaves it off. `portalctl install` copies it into the portal LaunchAgent (not the tunnel's) only when set to `1` at install time |

Directories, variables and launchd labels keep the project's earlier internal name, `herdr-portal`, so existing installs keep their token, ledger and audit log. `portalctl install` copies the port, `HERDR_BIN` and, when set at install time, `HERDR_PORTAL_STATE_DIR`, `HERDR_PORTAL_LOG_DIR`, `HERDR_PORTAL_HOSTS`, `HERDR_PORTAL_TUNNEL_METRICS`, `HERDR_PORTAL_DROP_DIR` and `CLOUDFLARED_BIN` into the LaunchAgents, plus `HERDR_PORTAL_ENABLE_AGENT_DECISION=1` and `HERDR_PORTAL_STRICT_VERSION=1` into the portal's only. The plist is rewritten on every install, so a flag not set at install time is dropped from it. A loaded job keeps the definition and environment it was loaded with; `start` and `restart` (kickstart) do not reread the plist. `install` over a loaded job therefore boots it out, waits up to 10 s until launchd no longer has it, writes the new plist and bootstraps it, then waits up to 10 s for a new portal instance (a new `build.instance_id` on authenticated `GET /api/health`) that reports the flags this install set. Any failure exits nonzero and says the state: a failed bootout leaves the old job and plist; a failed bootstrap leaves the service stopped. A fresh install (nothing loaded) is not health-checked; run `portalctl status` or read `build.flags`. `install` and `status` send the token only to a listener on the port that runs as this user (checked with `lsof`); otherwise they say so and send nothing, and `install` fails.

## Running as a service (macOS)

`bin/portalctl install` checks first and writes nothing if a check fails: `herdr` must resolve to an absolute, executable path that runs `--version` under launchd's minimal environment, and the port must be free unless this label already holds it. It then writes the portal's user LaunchAgent and, only when `cloudflared` resolves to an absolute executable, the tunnel's, and starts them. Services are per user, never root. `portalctl plist portal` prints the definition without installing anything. Other commands: `start`, `stop`, `restart`, `status`, `url`, `logs`, `token-copy` (token to the clipboard, never printed, cleared after 60 s if unchanged), `rotate-token`, `revoke` (stops the tunnel job and replaces the token), `uninstall`.

### A second instance or a migration

If the port is taken, install a fresh instance with its own `HERDR_PORTAL_PORT`, `HERDR_PORTAL_STATE_DIR`, `HERDR_PORTAL_LOG_DIR` and `HERDR_PORTAL_LAUNCHD_PREFIX`. Install never renames, copies or rotates existing state; moving an instance to new paths or labels is a manual step.
