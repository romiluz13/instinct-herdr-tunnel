'use strict';
// A small DOM that runs public/app.js without a browser and without a dependency. It implements only what the page
// uses, parses the real public/index.html (so a renamed id breaks a test), talks to a real portal over HTTP, and drives
// time with fake timers so polling can be stepped. It is not a browser: layout is whatever a test sets.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const VOID = new Set(['meta', 'link', 'input', 'br', 'hr', 'img']);
const BOOLEAN = new Set(['hidden', 'disabled', 'open', 'checked', 'required']);
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class Text {
  constructor(t) { this.nodeType = 3; this.nodeValue = String(t); this.parentNode = null; }
  get data() { return this.nodeValue; } set data(v) { this.nodeValue = String(v); }
  get textContent() { return this.nodeValue; }
}

function matches(el, sel) { // one compound selector: tag?#id?(.class)*([attr] | [attr=value])*
  const m = /^([a-z0-9]+)?(?:#([\w-]+))?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="?[^\]"]*"?)?\])*)$/i.exec(sel);
  if (!m) throw new Error('mini-dom: unsupported selector ' + sel);
  if (m[1] && el.localName !== m[1].toLowerCase()) return false;
  if (m[2] && el.getAttribute('id') !== m[2]) return false;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  for (const c of m[3].split('.').filter(Boolean)) if (!classes.includes(c)) return false;
  for (const a of m[4].match(/\[[^\]]+\]/g) || []) {
    const [, name, val] = /^\[([\w-]+)(?:="?([^\]"]*)"?)?\]$/.exec(a);
    if (!el.hasAttribute(name) || (val !== undefined && el.getAttribute(name) !== val)) return false;
  }
  return true;
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1; this.localName = tag.toLowerCase(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = new Map();
    this.scrollTop = 0; this.scrollLeft = 0; this.scrollHeight = 0; this.clientHeight = 0; this.clientWidth = 0; this.rect = null;
    this._value = undefined; this.style = { setProperty() {}, removeProperty() {} };
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute('data-' + kebab(String(k))) ?? undefined,
      set: (_, k, v) => { self.setAttribute('data-' + kebab(String(k)), v); return true; },
      has: (_, k) => self.hasAttribute('data-' + kebab(String(k))),
    });
    this.classList = {
      add: (...c) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...c])].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, force) => { const has = self.classList.contains(c); const want = force === undefined ? !has : force; self.classList[want ? 'add' : 'remove'](c); return want; },
    };
  }
  get id() { return this.getAttribute('id') || ''; } set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; } set className(v) { this.setAttribute('class', v); }
  get type() { return this.getAttribute('type') || ''; }
  get value() {
    if (this._value !== undefined) return this._value;
    return this.localName === 'textarea' ? this.textContent : this.getAttribute('value') || '';
  }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(String(v) === '' ? [] : [new Text(v)])); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  append(...nodes) { for (const n of nodes) this._adopt(typeof n === 'string' ? new Text(n) : n); }
  _adopt(n) { if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1); n.parentNode = this; this.childNodes.push(n); }
  replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/); const out = [];
    const walk = (el, depth) => {
      for (const c of el.children) {
        const hit = matches(c, parts[depth]);
        if (hit && depth === parts.length - 1) out.push(c);
        walk(c, hit && depth < parts.length - 1 ? depth + 1 : depth);
      }
    };
    walk(this, 0); return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type); if (l) l.splice(l.indexOf(fn), 1); }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    for (let el = this; el; el = el.parentNode) { ev.currentTarget = el; for (const fn of el.listeners.get(ev.type) || []) fn.call(el, ev); if (ev.cancelBubble) break; }
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent(makeEvent('click')); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 0, height: 0 }; }
}
for (const b of BOOLEAN) {
  Object.defineProperty(Element.prototype, b, {
    get() { return this.hasAttribute(b); },
    set(v) { if (v) this.setAttribute(b, ''); else this.removeAttribute(b); },
  });
}

function makeEvent(type, props = {}) {
  return { type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; }, ...props };
}

class Document {
  constructor() {
    this.hidden = false; this.activeElement = null; this.listeners = new Map();
    this.documentElement = new Element('html', this); this.body = new Element('body', this); this.documentElement.append(this.body);
  }
  createElement(tag) { return new Element(tag, this); }
  createTextNode(t) { return new Text(t); }
  getElementById(id) { return this.documentElement.querySelectorAll('[id=' + id + ']')[0] || null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  dispatchEvent(ev) { for (const fn of this.listeners.get(ev.type) || []) fn.call(this, ev); }
}

// Just enough HTML for public/index.html: tags, quoted and bare attributes, text, comments, void elements.
function parseInto(doc, html) {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)[1];
  const stack = [doc.body];
  const re = /<!--[\s\S]*?-->|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/gi;
  for (let m; (m = re.exec(body));) {
    const top = stack[stack.length - 1];
    if (m[1]) { stack.pop(); continue; }
    if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], a[2] === undefined ? '' : a[2]);
      top.append(el);
      if (m[2].toLowerCase() === 'script') { stack.push(el); continue; }
      if (!VOID.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[4] && m[4].trim()) top.append(new Text(m[4]));
  }
  return doc;
}

// Boots the page against a portal on `port`. Time only moves when a test calls advance() or tick().
function loadPage({ port }) {
  const doc = parseInto(new Document(), fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));
  const requests = []; let inflight = 0;
  const realFetch = globalThis.fetch;
  const fetch = (url, opts = {}) => {
    inflight += 1;
    requests.push({ method: opts.method || 'GET', path: url, body: opts.body ? JSON.parse(opts.body) : null });
    return realFetch('http://127.0.0.1:' + port + url, opts).finally(() => { inflight -= 1; });
  };
  const timers = []; let now = 0; let nextId = 1;
  const add = (fn, ms, every) => { const id = nextId++; timers.push({ id, fn, at: now + ms, every: every ? ms : 0 }); return id; };
  const clear = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  const win = {
    document: doc, fetch, AbortController, console, crypto: globalThis.crypto, URLSearchParams, encodeURIComponent,
    setTimeout: (fn, ms) => add(fn, ms, false), setInterval: (fn, ms) => add(fn, ms, true), clearTimeout: clear, clearInterval: clear,
    getComputedStyle: () => win.computed, computed: { lineHeight: '16px', paddingLeft: '10px', paddingTop: '10px' },
  };
  win.window = win;
  const context = vm.createContext(win);
  for (const f of ['viewer.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), context, { filename: f });

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function settle() {
    let quiet = 0;
    for (let i = 0; i < 6000 && quiet < 3; i++) { await pause(5); quiet = inflight === 0 ? quiet + 1 : 0; } // a click spawns several processes; a loaded machine needs seconds
  }
  // Fires every timer due within `ms` of fake time, without waiting for the requests they start.
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      now = due.at;
      if (due.every) due.at += due.every; else timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    now = end;
  }
  async function tick(ms) { // one timer at a time, letting its requests finish, so the next due time depends on the outcome
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      advance(due.at - now);
      await settle();
    }
    now = end;
  }
  const $ = (id) => doc.getElementById(id);
  const find = (sel, root = doc.documentElement) => root.querySelector(sel);
  const all = (sel, root = doc.documentElement) => root.querySelectorAll(sel);
  const button = (text, root = doc.documentElement) => all('button', root).find((b) => b.textContent.trim() === text) || null;
  const fire = (el, type, props) => el.dispatchEvent(makeEvent(type, props));
  return { doc, win, requests, timers: () => timers.slice(), settle, advance, tick, $, find, all, button, fire, pending: () => inflight };
}

module.exports = { loadPage, Element, Text, makeEvent };
