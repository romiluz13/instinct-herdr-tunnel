# Tests and live proofs

`npm test` (`node --test`) runs the suite against a fake Herdr, a fake `cloudflared`, a fake `launchctl` and fake `ps` and `stty`; no real pane, tunnel or launchd job is touched. On a machine without `/usr/sbin/lsof` (Linux CI) the three `portalctl install` tests that need it skip, because `portalctl` manages launchd and checks the port's owner with that `lsof`. The browser page is tested in a small DOM (`tests/fixtures/mini-dom.js`) that parses the real `public/index.html`, runs `app.js` and `viewer.js` and talks to a real portal over HTTP. It is not a browser, so `npm test` does not cover layout, touch input or the content security policy as a browser enforces it. Those were checked once, by hand, in a headless Chrome 156 on macOS against a fake Herdr behind a real portal (see [control.md](control.md#not-covered)); that check is not a script in this repository.

Node 22, 24 and 26 are supported (`engines` says `>=22`); the suite was run on all three at this revision. Run plain `node --test`: passing the directory, `node --test tests/`, fails on Node 22 and 24 with `Cannot find module '.../tests'`.

The suite starts many portals and fake tools in parallel and runs in real time. On a machine that is already heavily loaded a test can time out for no reason of its own (a portal slow to start, a fake `ps` that takes seconds); run the file alone with `node --test tests/<file>.test.js` before you suspect the code.

## Live proofs against a real Herdr

- `node scripts/e2e-control.js [--out file] [--keep]` proves history reads, scrolling and clicking, then runs `scripts/e2e.js` against the same portal. It starts its own Herdr server and portal in a fresh temporary home, so it never touches your sessions or your portal: before it sends anything it checks that its session is the only one running and that every socket lives inside the temporary home, and at the end it stops both by exact pid and removes the directory. The portal runs detached, with no controlling terminal. It prints one `PASS` or `FAIL` line per step and exits 0 with a `SKIP` line when `herdr` is not installed. `--out` saves the steps as JSON (git-ignored under `docs/e2e-*.json`); `--keep` leaves the temporary home for you to look at.
- `node scripts/e2e-plugin.js [--out file] [--keep]` proves the pane tag and the Herdr plugin ([plugin.md](plugin.md#how-it-was-checked)) the same way: its own Herdr server and portal in a fresh temporary home, the plugin linked from a copy, every process stopped by exact pid, `SKIP` when `herdr` is missing.
- `scripts/e2e.js` (read-only unless you pass a test pane), `scripts/smoke-actions.js` and `scripts/decision-proof.js` exercise a real Herdr through a running portal. The last two send input and start agents in the panes you give them, so stage a throwaway pane first; `decision-proof.js` checks refusals only.

What `e2e-control.js` does not prove is listed in [control.md](control.md#not-covered).

## The proof matrix

`node scripts/fetch-herdr-docs.js --version <installed version>` saves Herdr's pages into `docs/official/` (git-ignored), then `node scripts/gen-proof-matrix.js` writes [proof-matrix.md](proof-matrix.md); with `--check` it runs every check and writes nothing. A past live run counts only when its receipt matches the current source and Herdr build; otherwise the matrix says `untested`.

Not covered by any test here: a real `launchctl`, a real `cloudflared` or named tunnel, and a live run of `agent_decision` against the current source.
