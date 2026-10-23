#!/usr/bin/env node
'use strict';
// The action: Herdr gives an action no pane of its own, so this asks Herdr to open the activity pane as a tab, which leaves the
// layout and the owner's keyboard alone.
const herdr = require('../lib/herdr');

const sock = process.env.HERDR_SOCKET_PATH; const id = process.env.HERDR_PLUGIN_ID;
if (!sock || !id) { process.stderr.write('open-activity: HERDR_SOCKET_PATH and HERDR_PLUGIN_ID are not set; this runs as a Herdr plugin action\n'); process.exit(1); }
herdr.call(sock, 'plugin.pane.open', { plugin_id: id, entrypoint: 'activity', placement: 'tab', focus: true })
  .then(() => process.stdout.write('opened the activity tab\n'), (e) => { process.stderr.write(`open-activity: ${e.code || e.message}\n`); process.exit(1); });
