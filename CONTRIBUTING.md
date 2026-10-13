# Contributing

- `npm test` (plain `node --test`) must pass on Node 22 or newer. Tests run against fakes and touch no real pane, tunnel or launchd job; keep it that way.
- New or changed actions need an entry in `docs/api.md` (a test fails if it and the code disagree) and a row in `docs/proof-matrix.md` (`node scripts/gen-proof-matrix.js`; see [docs/development.md](docs/development.md)).
- The runtime has no npm dependencies. Please do not add any.
- Never include tokens, tunnel URLs, pane ids, file paths from your machine or screen text from a real agent in an issue, a pull request or a proof receipt.
- Changes that widen what a token holder can do (new actions, new keys, answering dialogs) need a stated reason and a test that shows the refusal paths.
