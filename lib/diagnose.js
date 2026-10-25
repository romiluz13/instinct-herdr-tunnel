'use strict';
// The read-only half of `portalctl diagnose`: what the tunnel's own log says about when it had no connection to Cloudflare.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STAMP = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\w+\s+(.*)$/;
const ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\[[0-9a-f:]+\](?::\d+)?/gi;
const SYSTEM_LOG = '/Library/Logs/com.cloudflare.cloudflared.err.log';
const TAIL_BYTES = 4 * 1024 * 1024;
const DAY = 24 * 3600 * 1000;
// Drops this close to the last one belong to the same outage; a connection that dropped long before and never came back does not.
const LEAD = 60 * 1000;

function field(text, name) {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|(\\S+))`).exec(text);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

// A connection that never came up, such as a fourth one that keeps answering "already connected", is not counted, so a tunnel that runs
// on three connections is judged by its three. A "Starting tunnel" line is a new cloudflared process: connections the old one never closed died with it.
function outages(text) {
  const live = new Set(); const dropped = new Map(); const windows = [];
  let drops = 0; let from = null; let midRun = false; let open = null;
  for (const line of String(text).split('\n')) {
    const m = STAMP.exec(line);
    if (!m) continue;
    const [, at, body] = m;
    if (!from) { from = at; midRun = !/^Starting tunnel\b/.test(body); }
    if (/^Starting tunnel\b/.test(body)) {
      if (live.size > 0) open = { firstDropAt: at, downAt: at, upAt: null, reason: 'cloudflared restarted without closing its connections' };
      live.clear(); dropped.clear();
      continue;
    }
    const conn = field(body, 'connIndex');
    if (conn === null) continue;
    if (/^Registered tunnel connection\b/.test(body)) {
      live.add(conn); dropped.delete(conn);
      if (open) { open.upAt = at; windows.push(open); open = null; dropped.clear(); }
    } else if (/^(Connection terminated|Unregistered tunnel connection)\b/.test(body) && live.delete(conn)) {
      drops += 1;
      dropped.set(conn, { at, reason: (field(body, 'error') || 'connection closed').replace(ADDRESS, '<addr>') });
      if (live.size === 0) {
        const first = [...dropped.values()].find((d) => Date.parse(at) - Date.parse(d.at) <= LEAD) || dropped.get(conn);
        open = { firstDropAt: first.at, downAt: at, upAt: null, reason: first.reason };
      }
    }
  }
  if (open) windows.push(open);
  return { windows, drops, from, midRun };
}

function jsonLines(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    try { const o = JSON.parse(line); if (o && typeof o === 'object') rows.push(o); } catch { /* a torn line at the cut of a tail, or text that is not JSON */ }
  }
  return rows;
}

// /healthz is a health check that other tools poll every few seconds (the plugin's activity tab does), so only other paths show that a caller
// got through. The portal log does not say whether a caller came through the tunnel or from this machine.
function lastRequest(portalLog) {
  const hit = jsonLines(portalLog).filter((o) => o.event === 'http' && typeof o.p === 'string' && o.p !== '/healthz').pop();
  return hit ? { at: hit.t, path: hit.p } : null;
}

// The audit log also records refusals and reads, so its newest line is not necessarily a write.
function lastAuditEntry(auditLog) {
  const hit = jsonLines(auditLog).filter((o) => typeof o.timestamp === 'string').pop();
  return hit ? hit.timestamp : null;
}

// "Wake Requests" is another pmset record type that starts with the same word; the type column is padded, which tells them apart.
const SLEEP_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-])(\d\d)(\d\d) (Sleep|Wake|DarkWake)(?: {2,}|\t)/;
function sleepEvents(pmsetLog) {
  const events = [];
  for (const line of String(pmsetLog).split('\n')) {
    const m = SLEEP_LINE.exec(line);
    if (m) events.push({ at: new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`).toISOString(), kind: m[6] });
  }
  return events;
}

// The public hostname identifies the owner's tunnel, so the report never carries it.
function stripHosts(text, hosts) {
  let out = String(text).replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '<url>');
  for (const h of hosts) if (h) out = out.replace(new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<host>');
  return out;
}

function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
}
const age = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))} s ago` : ms < 3600000 ? `${Math.floor(ms / 60000)} min ago` : `${Math.floor(ms / 3600000)} h ago`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function render(report, { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const hms = (iso) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(iso));
  // en-CA prints a date as YYYY-MM-DD and sv-SE a date and time as YYYY-MM-DD HH:MM:SS, so nothing has to be joined by hand.
  const day = (iso) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
  const when = (iso, ref) => (day(iso) === day(ref) ? '' : `${day(iso).slice(5)} `) + hms(iso);
  const stamp = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(report.now));
  const now = Date.parse(report.now);
  const since = now - DAY;
  const { portal, tunnel, outages: found } = report;
  const out = [`Tunnel diagnosis, ${stamp} (${timeZone}). Read-only: no token read, nothing changed.`];

  out.push(`portal   ${portal.loaded ? `loaded, pid ${portal.pid || '-'}` : 'not loaded'}, /healthz ${portal.healthz ? portal.healthz : 'did not answer'}`);

  if (tunnel.ready > 0) out.push(`tunnel   ${plural(tunnel.ready, 'connection')} ready (metrics ${tunnel.metrics})`);
  else if (tunnel.ready === 0) out.push(`tunnel   NO CONNECTIONS ready: the public address cannot reach the portal (metrics ${tunnel.metrics})`);
  else if (tunnel.probe === 'unreachable') out.push(`tunnel   metrics unreachable at ${tunnel.metrics} (cloudflared not running, or serving metrics elsewhere: HERDR_PORTAL_TUNNEL_METRICS)`);
  else out.push(`tunnel   metrics did not answer (${tunnel.probe}) at ${tunnel.metrics}`);

  const req = report.request === 'unreadable' ? 'the portal log could not be read'
    : report.request ? `last request handled ${when(report.request.at, report.now)} (${age(now - Date.parse(report.request.at))}, ${report.request.path})` : 'no request in the portal log';
  const aud = report.audit === 'unreadable' ? 'the audit log could not be read' : report.audit ? `last audit entry ${when(report.audit, report.now)}` : 'no entry in the audit log';
  out.push(`traffic  ${req}; ${aud}`);

  if (!found.source) out.push('outages  no cloudflared log found (set HERDR_PORTAL_TUNNEL_LOG)');
  else if (found.unreadable) out.push(`outages  could not read ${found.source}`);
  else if (!found.from) out.push(`outages  no cloudflared lines in ${found.source}`);
  else {
    const end = (w) => (w.upAt ? Date.parse(w.upAt) : now);
    const recent = found.windows.filter((w) => end(w) >= since);
    const down = recent.reduce((sum, w) => sum + end(w) - Math.max(Date.parse(w.downAt), since), 0);
    out.push(`outages  ${recent.length ? `${recent.length} in the last 24 h, ${span(down)} without any connection` : 'none in the last 24 h'}, from ${found.source} (${plural(found.drops, 'connection drop')} in the log)`);
    for (const w of recent) {
      const to = w.upAt ? `${when(w.upAt, w.downAt)}  ${span(Date.parse(w.upAt) - Date.parse(w.downAt))}` : `now  still down, ${span(now - Date.parse(w.downAt))} so far`;
      out.push(`  ${when(w.downAt, report.now)} to ${to}  (first drop ${when(w.firstDropAt, w.downAt)})  ${w.reason}`);
    }
    if (found.midRun) out.push(`  (the log read begins mid-run, at ${when(found.from, report.now)}; connections that registered before then are not counted)`);
    else if (Date.parse(found.from) > since) out.push(`  (the log read starts ${when(found.from, report.now)}, so earlier outages are not in it)`);
  }

  if (report.sleep === null) out.push('sleep    not available (pmset did not answer, or this is not macOS)');
  else {
    const slept = report.sleep.filter((e) => Date.parse(e.at) >= since);
    out.push(`sleep    ${slept.length ? `in the last 24 h: ${slept.map((e) => `${e.kind} ${hms(e.at)}`).join(', ')}` : 'none in the last 24 h'}`);
  }
  const net = report.network;
  out.push(`network  ${!net ? 'not available (route gave no answer, or this is not macOS)' : net.noRoute ? 'no default route' : `default route ${net.iface || '?'} via ${net.gateway || '?'}, address ${net.address || '?'}`}`);
  out.push('note     If the public address is behind Cloudflare Access, a 302 from it is Access answering and does not show the tunnel is up; "connections ready" does.');
  return out.map((l) => stripHosts(l, report.hosts || []));
}

// The end of a log is what a diagnosis needs, and a tail keeps the read small however long the file has grown.
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size; const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The portal's own tunnel job pipes everything cloudflared prints to its stdout, which launchd writes to tunnel.log; tunnel.err.log stays empty.
// When a cloudflared service runs the tunnel instead, that service logs elsewhere. A named log wins, even one that cannot be read, so the report
// never answers from a log the owner did not ask for; of the others, the one written to last belongs to the connector that is running.
function connectorLog(config) {
  const named = process.env.HERDR_PORTAL_TUNNEL_LOG;
  if (named) return named;
  const written = (f) => { try { const st = fs.statSync(f); return st.size > 0 ? st.mtimeMs : null; } catch { return null; } };
  const found = [path.join(config.logDir, 'tunnel.log'), path.join(config.logDir, 'tunnel.err.log'), SYSTEM_LOG, path.join(os.homedir(), 'Library', 'Logs', 'com.cloudflare.cloudflared.err.log')]
    .map((file) => ({ file, mtime: written(file) })).filter((c) => c.mtime !== null).sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].file : null;
}

function probeReady(addr) {
  const [host, port] = addr.split(':');
  return new Promise((resolve) => {
    const req = http.get({ host, port: Number(port), path: '/ready', timeout: 1500 }, (res) => {
      let body = ''; res.on('data', (c) => (body += c));
      res.on('end', () => {
        let n = null; try { n = JSON.parse(body).readyConnections; } catch { /* not JSON */ }
        resolve(Number.isInteger(n) ? { ready: n, probe: 'ready' } : { ready: null, probe: `answered ${res.statusCode} without a connection count` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ready: null, probe: 'timeout' }); });
    req.on('error', () => resolve({ ready: null, probe: 'unreachable' }));
  });
}

function healthz(config) {
  return new Promise((resolve) => {
    const req = http.get({ host: config.host, port: config.port, path: '/healthz', timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// macOS only: the other systems this portal runs on do not have these tools, and the report then says so.
function network() {
  const route = spawnSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 3000 });
  if (route.error || route.status === null) return null;
  const iface = /interface: (\S+)/.exec(route.stdout)?.[1];
  const gateway = /gateway: (\S+)/.exec(route.stdout)?.[1];
  if (!iface && !gateway) return /not in table/.test(`${route.stdout}${route.stderr}`) ? { noRoute: true } : null;
  const ifc = iface ? spawnSync('/sbin/ifconfig', [iface], { encoding: 'utf8', timeout: 3000 }) : null;
  return { iface, gateway, address: ifc && /\binet (\S+)/.exec(ifc.stdout || '')?.[1] };
}

async function collect({ config, launchd }) {
  const darwin = process.platform === 'darwin';
  const source = connectorLog(config);
  const connector = source ? tail(source) : null;
  const portalLogFile = path.join(config.logDir, 'portal.log');
  const portalLog = tail(portalLogFile);
  const auditLog = tail(config.auditFile);
  const pm = darwin ? spawnSync('/usr/bin/pmset', ['-g', 'log'], { encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 * 1024 }) : null;
  let urlHost = null; try { urlHost = new URL(fs.readFileSync(config.tunnelUrlFile, 'utf8').trim()).hostname; } catch { /* no tunnel url yet */ }
  const [healthStatus, tunnel] = await Promise.all([healthz(config), probeReady(config.metricsAddr)]);
  return {
    now: new Date().toISOString(),
    portal: { loaded: launchd.loaded, pid: launchd.pid, healthz: healthStatus },
    tunnel: { ...tunnel, metrics: config.metricsAddr },
    request: portalLog !== null ? lastRequest(portalLog) : fs.existsSync(portalLogFile) ? 'unreadable' : null,
    audit: auditLog !== null ? lastAuditEntry(auditLog) : fs.existsSync(config.auditFile) ? 'unreadable' : null,
    outages: !source ? { source: null } : connector !== null ? { source: path.basename(source), ...outages(connector) } : { source: path.basename(source), unreadable: true },
    sleep: pm && pm.status === 0 ? sleepEvents(pm.stdout) : null,
    network: darwin ? network() : null,
    hosts: [...config.extraAllowedHosts, urlHost].filter(Boolean),
  };
}

module.exports = { outages, lastRequest, lastAuditEntry, sleepEvents, stripHosts, render, collect };
