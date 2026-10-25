# See it work

A blocked agent on a fake Herdr, a run on a real one, and the commands that check the numbers the README quotes.

## A blocked agent is refused

A blocked agent is waiting on a permission dialog. A remote caller tries to push it along. Abridged real output from a throwaway portal on the test suite's fake Herdr (no real pane; the same cases run in `npm test`):

```text
# 1. prompt a BLOCKED agent
{ "http": 409, "error": { "code": "blocked_requires_decision", "agent_status": "blocked" } }

# 2. answer its dialog with agent_decision (default config)
{ "http": 404, "error": { "code": "action_disabled" } }

# keys the fake Herdr received for those two calls
[]

# 3. prompt an IDLE agent
{ "http": 200, "status": "input_sent" }

# 4. audit log (GET /api/herdr/audit_tail)
{"action":"herdr.agent_prompt","pane":"w1:p3","result":"rejected","http_status":409,"error_code":"blocked_requires_decision"}
{"action":"herdr.agent_prompt","pane":"w1:p2","result":"input_sent","http_status":200}
```

Dialogs stay with you: nothing reached the blocked agent, and the refusal is on the record. The one gap is described under [residual risks](security.md#residual-risks).

## Read, scroll and click on a real Herdr

`node scripts/e2e-control.js` starts its own Herdr server and portal in a temporary home, so it never touches your sessions, and drives them through the HTTP API. Output of a run on Herdr 0.9.5:

```text
PASS  the disposable Herdr started; its session is the only one running and every socket is inside the temporary home
PASS  four panes exist in the disposable session
PASS  the portal is up, writes are enabled, history and control are on
PASS  history: a plain shell returns far more than its screen, with the mode and the counts
PASS  host scrollback: two steps up moved the real offset by 6 lines and the screen changed
PASS  pane to bottom: offset 0 and the original screen is back
PASS  probe B17: pane.scroll answers pane_info, sets the offset, clamps to the maximum and 0 resets
PASS  the mouse app is on the alternate screen: no Herdr scrollback, so the wheel path applies
PASS  wheel scroll: three steps arrive as three wheel-up reports, with no position claimed and no resize
PASS  pane to bottom on a wheel pane is refused (422 bottom_unsupported)
PASS  click: the exact cell arrives as a mouse press and release, the size was verified and nothing was resized
PASS  a click whose text is not under the cell is refused with the row as it is (409 screen_changed), nothing arrives
PASS  a click for another terminal id is refused (409 target_changed)
PASS  probe B18: while an app owns the alternate screen the max offset is 0 and history says screen only
PASS  probe B18: when the app exits the shell scrollback is back
PASS  a reported agent that is idle returns the history of its main screen (the alternate-screen agent branch and Herdr paging a real agent are not proven here)
PASS  scrolling that agent pane is refused: read its history instead (409 use_history_read)
PASS  clicking it is refused until the owner enables agent clicks (409 agent_click_disabled)
PASS  scripts/e2e.js, including its write round trip, passes against the same disposable portal

ALL 19 STEPS PASSED on herdr 0.9.5
```

"Arrive" means a small program in the pane logged the bytes it received. What this run does *not* prove (a recognized agent paged by Herdr, which was checked once by hand, the owner typing during a click, a real Herdr on Linux) is listed in [control.md](control.md#not-covered). The run needs `herdr` on your `PATH` and prints `SKIP` and exits 0 without it.

## Check the numbers yourself

```sh
# the portal's actions
node -e 'console.log(Object.keys(require("./lib/actions").ACTIONS).length)'
# Herdr's request methods, from the installed Herdr's own schema
herdr api schema --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).schemas.request.oneOf.length))'
```

The first prints 26. The second printed 102 on Herdr 0.9.5. [The proof matrix](proof-matrix.md) lists each action against that schema.
