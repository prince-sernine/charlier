import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as esbuild from 'esbuild';

const nodeRequire = createRequire(import.meta.url);

// Lightweight, zero-dep Virtual DOM capable of executing CharlierSidebarProvider's inline script cleanly.
function createSidebarDomEnv(initialHtml) {
  let scrollY = 0;
  let webviewState = {};
  const postedMessages = [];
  const docListeners = new Map();
  const winListeners = new Map();
  let rafQueue = [];

  class ClassList {
    constructor(el) { this.el = el; }
    _set(arr) {
      const unique = Array.from(new Set(arr.filter(Boolean)));
      if (unique.length) this.el.attrs.set('class', unique.join(' '));
      else this.el.attrs.delete('class');
    }
    _list() { return (this.el.attrs.get('class') || '').trim().split(/\s+/).filter(Boolean); }
    contains(c) { return this._list().includes(c); }
    add(...cs) { this._set([...this._list(), ...cs]); }
    remove(...cs) { this._set(this._list().filter((x) => !cs.includes(x))); }
    toggle(c, force) {
      const has = this.contains(c);
      const want = force === undefined ? !has : Boolean(force);
      if (want) this.add(c);
      else this.remove(c);
      return want;
    }
  }

  class VNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentNode = null;
      this.childNodes = [];
    }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() {
      if (!this.parentNode) return null;
      const idx = this.parentNode.childNodes.indexOf(this);
      return idx >= 0 ? this.parentNode.childNodes[idx + 1] || null : null;
    }
    get isConnected() {
      let cur = this;
      while (cur.parentNode) cur = cur.parentNode;
      return cur === doc || cur === body || cur === doc.documentElement;
    }
    get parentElement() {
      return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
    }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
      if (n.nodeType === 11) {
        for (const k of [...n.childNodes]) this.insertBefore(k, ref);
        return n;
      }
      if (n.parentNode) n.parentNode.removeChild(n);
      const idx = ref ? this.childNodes.indexOf(ref) : -1;
      if (idx >= 0) this.childNodes.splice(idx, 0, n);
      else this.childNodes.push(n);
      n.parentNode = this;
      return n;
    }
    removeChild(n) {
      const idx = this.childNodes.indexOf(n);
      if (idx >= 0) {
        this.childNodes.splice(idx, 1);
        n.parentNode = null;
      }
      return n;
    }
    replaceWith(n) {
      if (!this.parentNode) return;
      const p = this.parentNode;
      p.insertBefore(n, this);
      p.removeChild(this);
    }
  }

  class VText extends VNode {
    constructor(val, nodeType = 3) {
      super(nodeType);
      this.nodeValue = val;
      this.nodeName = nodeType === 8 ? '#comment' : '#text';
    }
    cloneNode() { return new VText(this.nodeValue, this.nodeType); }
  }

  const camelToDataAttr = (k) => 'data-' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  const dataAttrToCamel = (a) => a.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

  class VElement extends VNode {
    constructor(tagName) {
      super(1);
      this.tagName = tagName;
      this.nodeName = tagName.toUpperCase();
      this.attrs = new Map();
      this.listeners = new Map();
      this.classList = new ClassList(this);
      this.dataset = new Proxy({}, {
        get: (_t, prop) => this.attrs.get(camelToDataAttr(String(prop))),
        set: (_t, prop, val) => { this.attrs.set(camelToDataAttr(String(prop)), String(val)); return true; },
        deleteProperty: (_t, prop) => { this.attrs.delete(camelToDataAttr(String(prop))); return true; },
        ownKeys: () => Array.from(this.attrs.keys()).filter((k) => k.startsWith('data-')).map(dataAttrToCamel),
        getOwnPropertyDescriptor: (_t, prop) => {
          const val = this.attrs.get(camelToDataAttr(String(prop)));
          return val !== undefined ? { enumerable: true, configurable: true, value: val } : undefined;
        }
      });
    }
    get id() { return this.attrs.get('id') || ''; }
    set id(v) { this.attrs.set('id', String(v)); }
    get hidden() { return this.attrs.has('hidden'); }
    set hidden(v) { if (v) this.attrs.set('hidden', ''); else this.attrs.delete('hidden'); }
    get value() { return this.attrs.get('value') || ''; }
    set value(v) { this.attrs.set('value', String(v)); }
    get attributes() {
      return Array.from(this.attrs.entries()).map(([name, value]) => ({ name, value }));
    }
    hasAttribute(name) { return this.attrs.has(name); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    get textContent() {
      return this.childNodes.map((c) => (c.nodeType === 1 ? c.textContent : c.nodeValue)).join('');
    }
    set textContent(v) {
      this.childNodes = [];
      if (v !== '' && v !== null && v !== undefined) {
        this.appendChild(new VText(String(v)));
      }
    }
    get innerHTML() {
      return this.childNodes.map((c) => {
        if (c.nodeType === 3) return c.nodeValue;
        if (c.nodeType === 8) return `<!--${c.nodeValue}-->`;
        const attrs = c.attributes.map((a) => (a.value === '' ? a.name : `${a.name}="${a.value}"`)).join(' ');
        const open = attrs ? `<${c.tagName} ${attrs}>` : `<${c.tagName}>`;
        return ['input', 'br', 'hr'].includes(c.tagName.toLowerCase()) ? open : `${open}${c.innerHTML}</${c.tagName}>`;
      }).join('');
    }
    set innerHTML(html) {
      this.childNodes = [];
      for (const n of parseHtmlFragment(String(html))) {
        this.appendChild(n);
      }
    }
    get outerHTML() {
      const attrs = this.attributes.map((a) => (a.value === '' ? a.name : `${a.name}="${a.value}"`)).join(' ');
      const open = attrs ? `<${this.tagName} ${attrs}>` : `<${this.tagName}>`;
      return `${open}${this.innerHTML}</${this.tagName}>`;
    }
    cloneNode(deep) {
      const copy = new VElement(this.tagName);
      for (const [k, v] of this.attrs.entries()) copy.attrs.set(k, v);
      if (deep) {
        for (const c of this.childNodes) copy.appendChild(c.cloneNode(true));
      }
      return copy;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    focus() {}
    setSelectionRange() {}
    matchesSimple(sel) {
      const tokens = sel.match(/(?:#[^\s.#[]+|\.[^\s.#[]+|\[[^\]]+\]|[^\s.#[]+)/g) || [];
      if (tokens.length === 0) return false;
      for (const tok of tokens) {
        if (tok.startsWith('#')) {
          if (this.id !== tok.slice(1)) return false;
        } else if (tok.startsWith('.')) {
          if (!this.classList.contains(tok.slice(1))) return false;
        } else if (tok.startsWith('[')) {
          const m = tok.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
          if (!m) return false;
          if (m[2] === undefined ? !this.hasAttribute(m[1]) : this.getAttribute(m[1]) !== m[2]) return false;
        } else if (this.tagName.toLowerCase() !== tok.toLowerCase()) {
          return false;
        }
      }
      return true;
    }
    matchesSelector(sel) {
      const parts = sel.trim().split(/\s+/);
      if (!this.matchesSimple(parts[parts.length - 1])) return false;
      let cur = this.parentElement;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (cur && !cur.matchesSimple(parts[i])) {
          cur = cur.parentElement;
        }
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    }
    closest(sel) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matchesSelector(sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType === 1) {
            if (c.matchesSelector(sel)) out.push(c);
            walk(c);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  function decodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  function parseHtmlFragment(html) {
    const voidTags = new Set(['input', 'br', 'hr', 'meta', 'link', 'img']);
    const rootFrag = { childNodes: [], appendChild(n) { n.parentNode = null; this.childNodes.push(n); } };
    const stack = [rootFrag];
    let pos = 0;
    while (pos < html.length) {
      const lt = html.indexOf('<', pos);
      if (lt < 0) {
        const txt = html.slice(pos);
        if (txt) stack[stack.length - 1].appendChild(new VText(decodeEntities(txt)));
        break;
      }
      if (lt > pos) {
        stack[stack.length - 1].appendChild(new VText(decodeEntities(html.slice(pos, lt))));
      }
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        const endIdx = end >= 0 ? end + 3 : html.length;
        stack[stack.length - 1].appendChild(new VText(html.slice(lt + 4, end >= 0 ? end : html.length), 8));
        pos = endIdx;
        continue;
      }
      const gt = html.indexOf('>', lt);
      if (gt < 0) break;
      const inside = html.slice(lt + 1, gt).trim();
      pos = gt + 1;
      if (inside.startsWith('!')) continue;
      if (inside.startsWith('/')) {
        const closing = inside.slice(1).trim().toLowerCase();
        while (stack.length > 1) {
          const top = stack.pop();
          if (top.tagName && top.tagName.toLowerCase() === closing) break;
        }
        continue;
      }
      const selfClosing = inside.endsWith('/');
      const clean = selfClosing ? inside.slice(0, -1).trim() : inside;
      const spaceIdx = clean.search(/\s/);
      const tag = spaceIdx < 0 ? clean : clean.slice(0, spaceIdx);
      const attrPart = spaceIdx < 0 ? '' : clean.slice(spaceIdx + 1);
      const el = new VElement(tag);
      const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let m;
      while ((m = attrRe.exec(attrPart))) {
        const key = m[1];
        const val = m[2] ?? m[3] ?? m[4] ?? '';
        el.setAttribute(key, decodeEntities(val));
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClosing && !voidTags.has(tag.toLowerCase())) {
        stack.push(el);
      }
    }
    return rootFrag.childNodes;
  }

  class VTemplate extends VElement {
    constructor() {
      super('template');
      const self = this;
      this.content = {
        get childNodes() { return self.childNodes; }
      };
    }
  }

  const bodyMatch = initialHtml.match(/<body[^>]*>([\s\S]*)<script nonce=[^>]*>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(bodyMatch, 'expected <body> and inline <script> in Cockpit HTML');
  const [, bodyInner, scriptCode] = bodyMatch;

  const htmlEl = new VElement('html');
  const body = new VElement('body');
  htmlEl.appendChild(body);
  body.innerHTML = bodyInner;

  const doc = {
    documentElement: htmlEl,
    body,
    visibilityState: 'visible',
    getElementById: (id) => body.querySelector('#' + id),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    createElement: (tag) => (tag === 'template' ? new VTemplate() : new VElement(tag)),
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    }
  };

  const win = {
    get scrollY() { return scrollY; },
    scrollTo: (_x, y) => { scrollY = Number(y) || 0; },
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    }
  };

  const sandbox = {
    document: doc,
    window: win,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    setTimeout,
    clearTimeout,
    Date,
    Array,
    Set,
    Map,
    Number,
    String,
    Boolean,
    acquireVsCodeApi: () => ({
      getState: () => webviewState,
      setState: (s) => { webviewState = s; },
      postMessage: (m) => { postedMessages.push(m); }
    })
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(scriptCode, sandbox);

  const flushRaf = () => {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb(Date.now());
  };
  flushRaf();

  return {
    doc,
    body,
    win,
    postedMessages,
    getScrollY: () => scrollY,
    setScrollY: (y) => {
      scrollY = y;
      for (const fn of winListeners.get('scroll') || []) fn({});
      flushRaf();
    },
    postFromHost: (data) => {
      for (const fn of winListeners.get('message') || []) fn({ data });
    },
    click: (el) => {
      for (const fn of docListeners.get('click') || []) fn({ target: el });
    },
    flushRaf
  };
}

test('flicker invariants E2E: real Cockpit script preserves hero node, drawer animation gating, scrollY, busy scope, and monotonic CLI button', async () => {
  const result = await esbuild.build({
    entryPoints: ['src/sidebar.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', result.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  const provider = new mod.exports.CharlierSidebarProvider({});

  const agyP1 = { id: 'a1', provider: 'antigravity', name: 'Agy Main', email: 'a1@example.test', planOverride: 'PRO', updatedAt: Date.now(), cachedQuota: { plan: 'PRO', gemini: '88%', claudeGpt: '91%', argon: '75%', updatedAt: Date.now() } };
  const agyP2 = { id: 'a2', provider: 'antigravity', name: 'Agy Two', email: 'a2@example.test', planOverride: 'PRO', updatedAt: Date.now(), cachedQuota: { plan: 'PRO', gemini: '70%', claudeGpt: '80%', argon: '65%', updatedAt: Date.now() } };
  const agyP3 = { id: 'a3', provider: 'antigravity', name: 'Agy Three', email: 'a3@example.test', planOverride: 'FREE', updatedAt: Date.now(), cachedQuota: { plan: 'FREE', gemini: '95%', updatedAt: Date.now() } };
  const cP1 = { id: 'c1', provider: 'codex', name: 'Codex Main', email: 'c1@example.test', planOverride: 'PLUS', updatedAt: Date.now(), cachedQuota: { plan: 'PLUS', codex5h: '90%', codex7d: '80%', updatedAt: Date.now() } };
  const cP2 = { id: 'c2', provider: 'codex', name: 'Codex Two', email: 'c2@example.test', planOverride: 'PLUS', updatedAt: Date.now(), cachedQuota: { plan: 'PLUS', codex5h: '60%', codex7d: '50%', updatedAt: Date.now() } };

  const makeState = (selectedProvider, claimedAgyIds = []) => ({
    selectedProvider,
    antigravity: {
      profiles: [agyP1, agyP2, agyP3],
      activeProfileId: 'a1',
      cliProfileId: null,
      claimedProfileIds: new Set(claimedAgyIds),
      sessionKind: 'saved',
      liveSession: { email: 'a1@example.test', hasOAuthCreds: true, isExpired: false },
      liveMetrics: null,
      formatReset: () => ''
    },
    codex: {
      profiles: [cP1, cP2],
      activeProfileId: 'c1',
      cliProfileId: null,
      claimedProfileIds: new Set(),
      sessionKind: 'saved',
      liveSession: { email: 'c1@example.test', hasOAuthCreds: true, isExpired: false },
      liveMetrics: null
    }
  });

  const s1 = makeState('antigravity');
  const dom = createSidebarDomEnv(provider.buildHtml(s1));

  // 1. Capture hero card node reference before flipping deck
  const heroBefore = dom.doc.querySelector('.hero-card');
  assert.ok(heroBefore);

  // Expand standby card a2 drawer via click -> must gain .is-opening briefly
  const toggleA2 = dom.doc.querySelector('[data-toggle-drawer="a2"]');
  dom.click(toggleA2);
  const drawerA2 = dom.doc.querySelector('[data-drawer-for="a2"]');
  assert.equal(drawerA2.hidden, false);
  assert.equal(drawerA2.classList.contains('is-opening'), true, 'manual click toggle applies .is-opening');
  drawerA2.classList.remove('is-opening');

  // Scroll Antigravity deck & click Refresh All (becomes busy with busyProvider='antigravity')
  dom.setScrollY(240);
  const refreshBtn = dom.doc.querySelector('[data-action="REFRESH_ALL"]');
  dom.click(refreshBtn);
  assert.equal(refreshBtn.classList.contains('is-busy'), true);

  // Flip deck to Codex -> hero node MUST be preserved (same reference via data-card-key="hero-card"),
  // deck-snap toggles cleanly, scrollY resets to 0 for Codex, and stale busyProvider is NOT left busy on Codex deck!
  const sCodex = makeState('codex');
  dom.postFromHost({ type: 'PATCH_DOM', selectedProvider: 'codex', bodyHtml: provider.buildBodyHtml(sCodex) });
  assert.equal(dom.doc.querySelector('.hero-card'), heroBefore, 'hero card DOM element must survive deck flip');
  assert.equal(dom.body.classList.contains('deck-snap'), true, 'deck-snap must guard cross-deck flip');
  dom.flushRaf();
  assert.equal(dom.body.classList.contains('deck-snap'), true, 'requires second rAF to release deck-snap');
  dom.flushRaf();
  assert.equal(dom.body.classList.contains('deck-snap'), false);
  assert.equal(dom.getScrollY(), 0, 'Codex deck starts at scrollY 0');
  assert.equal(
    dom.doc.querySelector('[data-action="REFRESH_ALL"]').classList.contains('is-busy'),
    false,
    'Antigravity busy state must not stay visually stuck on Codex Refresh All'
  );

  // Scroll Codex to 120, then flip back to Antigravity -> Antigravity restores 240
  dom.setScrollY(120);
  dom.postFromHost({ type: 'PATCH_DOM', selectedProvider: 'antigravity', bodyHtml: provider.buildBodyHtml(s1) });
  dom.flushRaf();
  dom.flushRaf();
  assert.equal(dom.getScrollY(), 240, 'Antigravity deck preserves its independent scrollY');
  assert.equal(drawerA2.hidden, false, 'Antigravity expanded drawer remains open after deck roundtrip');

  // Expand a3 (initially last standby card), then reorder via CLI CLAIMED on a3:
  const toggleA3 = dom.doc.querySelector('[data-toggle-drawer="a3"]');
  dom.click(toggleA3);
  const drawerA3 = dom.doc.querySelector('[data-drawer-for="a3"]');
  assert.equal(drawerA3.hidden, false);
  drawerA3.classList.remove('is-opening');

  // Click CLI Only on a3 -> transitions to Launching..., then PATCH_DOM arrives with a3 claimed!
  const cliBtnA3 = dom.doc.querySelector('[data-card-key="a3"] .btn-cli-only');
  dom.click(cliBtnA3);
  assert.equal(cliBtnA3.classList.contains('is-busy'), true);
  assert.equal(cliBtnA3.textContent, 'Launching...');

  const sClaimed = makeState('antigravity', ['a3']);
  dom.postFromHost({ type: 'PATCH_DOM', selectedProvider: 'antigravity', bodyHtml: provider.buildBodyHtml(sClaimed) });

  // After reorder + claim morph:
  // - drawerA3 stayed open without re-triggering .is-opening
  assert.equal(drawerA3.hidden, false);
  assert.equal(drawerA3.classList.contains('is-opening'), false, 'reordering an already-open card must NOT re-animate drawer');
  // - CLI button atomically cleared is-busy and landed directly on >_ Focus CLI (monotonic, no stuck Launching...)
  assert.equal(cliBtnA3.classList.contains('is-claimed'), true);
  assert.equal(cliBtnA3.classList.contains('is-busy'), false, 'morphing to .is-claimed must atomically clear is-busy');
  assert.equal(cliBtnA3.textContent, '>_ Focus CLI');

  // Clicking Focus CLI must NEVER apply is-busy or 'Focusing...' text!
  dom.click(cliBtnA3);
  assert.equal(cliBtnA3.classList.contains('is-busy'), false);
  assert.equal(cliBtnA3.textContent, '>_ Focus CLI');
});

test('flicker invariants: CSS gates drawerReveal on .is-opening, locks .btn-cli-only width, and StatusBar avoids redundant sets & orders bg/color monotonically', async () => {
  const css = fs.readFileSync('media/cockpit.css', 'utf8');
  const drawerRule = css.match(/\.card-drawer\s*\{([^}]*)\}/);
  assert.ok(drawerRule && !/animation:/.test(drawerRule[1]), '.card-drawer base rule must not rerun animation on insertBefore');
  assert.match(css, /\.card-drawer\.is-opening\s*\{[^}]*animation:\s*drawerReveal/);
  assert.match(css, /\.btn-cli-only\s*\{[^}]*min-width:\s*86px/);
  assert.match(css, /\.account-card\s*\{[^}]*contain:\s*layout style/);

  // Instrumented StatusBarItem test
  const propertyLog = [];
  const statusBarItem = {
    _text: '',
    _color: undefined,
    _bg: undefined,
    _tooltip: undefined,
    _a11y: undefined,
    get text() { return this._text; },
    set text(v) { this._text = v; propertyLog.push(['text', v]); },
    get color() { return this._color; },
    set color(v) { this._color = v; propertyLog.push(['color', v?.id ?? v]); },
    get backgroundColor() { return this._bg; },
    set backgroundColor(v) { this._bg = v; propertyLog.push(['bg', v?.id ?? v]); },
    get tooltip() { return this._tooltip; },
    set tooltip(v) { this._tooltip = v; propertyLog.push(['tooltip']); },
    get accessibilityInformation() { return this._a11y; },
    set accessibilityInformation(v) { this._a11y = v; propertyLog.push(['a11y']); },
    show() {},
    hide() {},
    dispose() {}
  };

  const vscode = {
    StatusBarAlignment: { Right: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class {
      value = '';
      appendMarkdown(v) { this.value += v; }
    },
    Uri: { parse: (u) => u },
    env: { appName: 'Antigravity' },
    extensions: { getExtension: () => undefined },
    commands: { executeCommand: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
    window: { createStatusBarItem: () => statusBarItem }
  };

  const builtUi = await esbuild.build({
    entryPoints: ['src/ui.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', builtUi.outputFiles[0].text)(
    (name) => (name === 'vscode' ? vscode : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );

  let agyQuotaVal = '90%';
  const agyProf = { id: 'a1', name: 'Main', email: 'a1@example.test', cachedQuota: { plan: 'PRO', gemini: '90%', claudeGpt: '90%', argon: '90%', updatedAt: Date.now() } };
  const controller = new mod.exports.UIController(
    {
      getState: () => ({ selectedProvider: 'antigravity', activeProfileId: 'a1' }),
      saveState: () => {},
      listProfiles: () => [agyProf],
      getLiveSessionInfoAsync: async () => ({ email: 'a1@example.test', hasOAuthCreds: true, isExpired: false }),
      updateProfileCachedQuota: () => {},
      updateProfileAuthHealth: () => {},
      syncActiveCredentialsToProfileAsync: async () => false
    },
    {
      getCachedSummary: () => ({ email: 'a1@example.test', groups: [{ modelLabel: 'Gemini', remainingFraction: 0.9 }], fetchedAt: Date.now() }),
      parseMetrics: () => ({ plan: 'PRO', gemini: agyQuotaVal, claudeGpt: agyQuotaVal, argon: agyQuotaVal, updatedAt: Date.now() }),
      buildAccountsHoverTooltip: () => 'hover-1'
    },
    { listProfiles: () => [], getLiveSessionInfo: () => ({}), findMatchingProfile: () => null },
    { getCachedMetric: () => null, buildCodexHoverTooltip: () => 'codex-hover' }
  );

  try {
    await controller.update(true);
    const countAfterFirst = propertyLog.length;
    assert.ok(countAfterFirst > 0);

    // Second no-op update must produce ZERO StatusBar property writes
    await controller.update(true);
    assert.equal(propertyLog.length, countAfterFirst, 'no-op update must cause zero StatusBar property mutations');

    // Transition to depleted (0% -> errorBackground): bg MUST be written before clearing color!
    propertyLog.length = 0;
    agyQuotaVal = '0%';
    controller.quotaService.getCachedSummary = () => ({ email: 'a1@example.test', groups: [{ modelLabel: 'Gemini', remainingFraction: 0 }], fetchedAt: Date.now() });
    await controller.update(true);
    const bgIdx = propertyLog.findIndex(([k, v]) => k === 'bg' && Boolean(v));
    const colorIdx = propertyLog.findIndex(([k]) => k === 'color');
    assert.ok(bgIdx >= 0 && colorIdx > bgIdx, 'when entering bg error/warning state, backgroundColor must apply before color');

    // Recover back to 90%: new color MUST be written before clearing backgroundColor!
    propertyLog.length = 0;
    agyQuotaVal = '90%';
    controller.quotaService.getCachedSummary = () => ({ email: 'a1@example.test', groups: [{ modelLabel: 'Gemini', remainingFraction: 0.9 }], fetchedAt: Date.now() });
    await controller.update(true);
    const recColorIdx = propertyLog.findIndex(([k, v]) => k === 'color' && Boolean(v));
    const recBgClearIdx = propertyLog.findIndex(([k, v]) => k === 'bg' && v === undefined);
    assert.ok(recColorIdx >= 0 && recBgClearIdx > recColorIdx, 'when leaving bg state, color must apply before clearing backgroundColor');
  } finally {
    controller.dispose();
  }
});

test('Cockpit PATCH_DOM live-updates 5h bars independently when 7d stays unchanged across Antigravity & Codex Hero and Standby drawers', async () => {
  const built = await esbuild.build({
    entryPoints: ['src/sidebar.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    write: false,
    logLevel: 'silent'
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', built.outputFiles[0].text)(
    (name) => (name === 'vscode' ? {} : nodeRequire(name)),
    mod,
    mod.exports,
    path.resolve('dist')
  );
  const prov = new mod.exports.CharlierSidebarProvider({
    onSelectProvider: async () => {},
    onSwitchProfile: async () => {},
    onRefreshAll: async () => {},
    onRefreshSingle: async () => {},
    onSaveActive: async () => {},
    onAddAccount: async () => {},
    onRenameProfile: async () => {},
    onDeleteProfile: async () => {}
  });

  const future5h = new Date(Date.now() + 4 * 3600_000).toISOString();
  const future7d = new Date(Date.now() + 6 * 86400_000).toISOString();
  const mkState = (selectedProvider, g5, g7, c5, c7, st5, st7, cx5, cx7) => ({
    selectedProvider,
    antigravity: {
      profiles: [
        {
          id: 'a1',
          name: 'ActivePro',
          email: 'a1@charlier.dev',
          updatedAt: Date.now(),
          cachedQuota: {
            plan: 'PRO',
            gemini: `${Math.min(g5, g7)}%`,
            claudeGpt: `${Math.min(c5, c7)}%`,
            argon: '--',
            gemini5h: `${g5}%`,
            gemini5hReset: future5h,
            gemini7d: `${g7}%`,
            gemini7dReset: future7d,
            claude5h: `${c5}%`,
            claude5hReset: future5h,
            claude7d: `${c7}%`,
            claude7dReset: future7d,
            updatedAt: Date.now()
          }
        },
        {
          id: 'a2',
          name: 'StandbyPro',
          email: 'a2@charlier.dev',
          updatedAt: Date.now() - 1000,
          cachedQuota: {
            plan: 'PRO',
            gemini: `${Math.min(st5, st7)}%`,
            claudeGpt: '100%',
            argon: '--',
            gemini5h: `${st5}%`,
            gemini5hReset: future5h,
            gemini7d: `${st7}%`,
            gemini7dReset: future7d,
            claude5h: '100%',
            claude5hReset: future5h,
            claude7d: '100%',
            claude7dReset: future7d,
            updatedAt: Date.now()
          }
        }
      ],
      activeProfileId: 'a1',
      sessionKind: 'saved',
      liveSession: { email: 'a1@charlier.dev', hasOAuthCreds: true, tokenExpiryDate: null, isExpired: false },
      liveMetrics: {
        plan: 'PRO',
        gemini: `${Math.min(g5, g7)}%`,
        claudeGpt: `${Math.min(c5, c7)}%`,
        argon: '--',
        gemini5h: `${g5}%`,
        gemini5hReset: future5h,
        gemini7d: `${g7}%`,
        gemini7dReset: future7d,
        claude5h: `${c5}%`,
        claude5hReset: future5h,
        claude7d: `${c7}%`,
        claude7dReset: future7d,
        updatedAt: Date.now()
      },
      formatReset: (iso) => (iso ? '4h 10m' : '')
    },
    codex: {
      profiles: [
        {
          id: 'c1',
          name: 'CodexHero',
          email: 'c1@charlier.dev',
          authMode: 'chatgpt',
          updatedAt: Date.now(),
          cachedQuota: {
            plan: 'PLUS',
            gemini: `${cx5}%`,
            claudeGpt: `${cx7}%`,
            argon: '--',
            codex5h: `${cx5}%`,
            codex5hReset: '3h 20m',
            codex7d: `${cx7}%`,
            codex7dReset: '5d 12h',
            updatedAt: Date.now()
          }
        }
      ],
      activeProfileId: 'c1',
      sessionKind: 'saved',
      liveSession: { email: 'c1@charlier.dev', accountId: 'acc-1', hasOAuthCreds: true, tokenExpiryDate: null, isExpired: false },
      liveMetrics: {
        plan: 'PLUS',
        gemini: `${cx5}%`,
        claudeGpt: `${cx7}%`,
        argon: '--',
        codex5h: `${cx5}%`,
        codex5hReset: '3h 20m',
        codex7d: `${cx7}%`,
        codex7dReset: '5d 12h',
        updatedAt: Date.now()
      }
    }
  });

  const dom = createSidebarDomEnv(prov.buildHtml(mkState('antigravity', 94, 73, 0, 34, 80, 60, 82, 69)));
  const getPool = (scopeSel, key) => {
    const scope = dom.doc.querySelector(scopeSel);
    const row = (scope?.querySelectorAll('.pool-row') || []).find(
      (r) => r.getAttribute('data-card-key') === key
    );
    return {
      val: row?.querySelector('.pool-val')?.textContent,
      style: row?.querySelector('.pool-bar-fill')?.getAttribute('style') || '',
      reset: row?.querySelector('.pool-reset')?.textContent
    };
  };

  assert.equal(getPool('#hero-section', 'pool-Gemini · 5h Fast Pool').val, '94%');
  assert.ok(getPool('#hero-section', 'pool-Gemini · 5h Fast Pool').style.includes('width: 94%'));
  // 100% standby Claude 5h must show Active instead of a reset countdown
  assert.equal(getPool('#drawer-a2', 'pool-Claude & GPT · 5h Fast Pool').reset, 'Active');

  // Move ONLY 5h (94% -> 88%, standby 80% -> 71%) while 7d stays untouched (73% / 60%)
  dom.postFromHost({
    type: 'PATCH_DOM',
    selectedProvider: 'antigravity',
    bodyHtml: prov.buildBodyHtml(mkState('antigravity', 88, 73, 0, 34, 71, 60, 82, 69))
  });
  assert.equal(getPool('#hero-section', 'pool-Gemini · 5h Fast Pool').val, '88%');
  assert.ok(getPool('#hero-section', 'pool-Gemini · 5h Fast Pool').style.includes('width: 88%'));
  assert.equal(getPool('#hero-section', 'pool-Gemini · 7d Weekly Pool').val, '73%');
  assert.equal(getPool('#drawer-a2', 'pool-Gemini · 5h Fast Pool').val, '71%');
  assert.ok(getPool('#drawer-a2', 'pool-Gemini · 5h Fast Pool').style.includes('width: 71%'));

  // Flip to Codex and move ONLY Codex 5h (82% -> 74%) while 7d stays 69%
  dom.postFromHost({
    type: 'PATCH_DOM',
    selectedProvider: 'codex',
    bodyHtml: prov.buildBodyHtml(mkState('codex', 88, 73, 0, 34, 71, 60, 82, 69))
  });
  assert.equal(getPool('#hero-section', 'pool-Codex · 5-Hour Fast Pool').val, '82%');
  dom.postFromHost({
    type: 'PATCH_DOM',
    selectedProvider: 'codex',
    bodyHtml: prov.buildBodyHtml(mkState('codex', 88, 73, 0, 34, 71, 60, 74, 69))
  });
  assert.equal(getPool('#hero-section', 'pool-Codex · 5-Hour Fast Pool').val, '74%');
  assert.ok(getPool('#hero-section', 'pool-Codex · 5-Hour Fast Pool').style.includes('width: 74%'));
  assert.equal(getPool('#hero-section', 'pool-Codex · 7-Day Weekly Pool').val, '69%');
});
