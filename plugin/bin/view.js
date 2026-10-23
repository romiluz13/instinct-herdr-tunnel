#!/usr/bin/env node
'use strict';
// The actions that narrow Herdr's Agents list to the agents the portal touched recently, and put it back. Display only.
const herdr = require('../lib/herdr');
const { TOKEN, VIEW_LABEL } = require('../lib/names');

const sock = process.env.HERDR_SOCKET_PATH; const id = process.env.HERDR_PLUGIN_ID; const mode = process.argv[2];
if (!sock || !id || !['set', 'clear'].includes(mode)) { process.stderr.write('usage (run by Herdr): view.js set|clear\n'); process.exit(1); }
const source = 'plugin:' + id;
const request = mode === 'set'
  ? herdr.call(sock, 'agent.view.set', { source, label: VIEW_LABEL, filter: { op: 'exists', field: { token: TOKEN } }, sort: [{ field: 'attention', order: 'desc' }, { field: 'state_change_seq', order: 'desc' }] })
  : herdr.call(sock, 'agent.view.clear', { source });
request.then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); }, (e) => { process.stderr.write(`view ${mode}: ${e.code || e.message}\n`); process.exit(1); });
