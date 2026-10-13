# Tests and live proofs

`npm test` (`node --test`) runs 58 tests against a fake Herdr, a fake `cloudflared` and a fake `launchctl`; no real pane, tunnel or launchd job is touched. They passed on Node 22.23, 24.21 and 26.10 on macOS. Run plain `node --test`: `node --test tests/` fails on Node 24.

Three scripts exercise a real Herdr through a running portal: `scripts/e2e.js` (read-only unless you pass a test pane), `scripts/smoke-actions.js` and `scripts/decision-proof.js`. The last two send input and start agents in the panes you give them, so stage a throwaway pane first; `decision-proof.js` checks refusals only. To regenerate the proof matrix, run `node scripts/fetch-herdr-docs.js` (it saves Herdr's pages into `docs/official/`, which is git-ignored), then `node scripts/gen-proof-matrix.js`. A past live run counts only when its receipt matches the current source and Herdr build; otherwise the matrix says `untested`.

Not covered: a real `launchctl`, a real `cloudflared` or named tunnel, and a live run of `agent_decision` against the current source.
