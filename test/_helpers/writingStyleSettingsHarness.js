'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Settings = require('../../extension/src/content/writingStyleSettings');
const SensitivePreflight = require('../../extension/src/content/sensitivePreflight');
const SensitiveScan = require('../../extension/src/shared/sensitiveScan');
const { normalizeGovernanceRules } = require('../../extension/src/shared/governanceRules');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.className = ''; this._text = ''; this.isConnected = true; this.classList = { add: (...x) => { this.className += ' ' + x.join(' '); } }; }
  append(...children) { for (const x of children) { this.children.push(x); x.parent = this; } }
  prepend(...children) { this.children.unshift(...children); for (const x of children) x.parent = this; }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(' '); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  dispatch(type) { for (const callback of this.listeners[type] || []) callback({ target: this }); }
  contains(x) { return x === this || this.children.some(c => c.contains(x)); }
  matches(selector) {
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (data) { const key = data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return Object.hasOwn(this.dataset, key) && (data[2] === undefined || this.dataset[key] === data[2]); }
    return false;
  }
  querySelector(selector) { for (const c of this.children) { if (c.matches(selector)) return c; const found = c.querySelector(selector); if (found) return found; } return null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  focus() { document.activeElement = this; }
}
async function flush() { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); }
async function harness(t, { rules = {}, marker = '', approve = false, locale = 'en', onConfirm, metadata, initializeOnly = false, buildError, overrides = {} } = {}) {
  const saved = Object.fromEntries(['document', 'chrome', 'MutationObserver'].map(k => [k, global[k]]));
  t.after(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete global[k] : global[k] = v; });
  global.document = { activeElement: null, createElement: tag => new Element(tag), createElementNS: (_ns, tag) => new Element(tag) };
  global.chrome = { storage: { local: { set: async () => {} }, onChanged: { addListener() {} } } };
  global.MutationObserver = class { observe() {} };
  const panel = new Element('section'), host = new Element('div'); host.dataset.writingStyleSettings = ''; panel.append(host);
  let scope = { accountScopeId: 'account-one', projectId: 'target-one' };
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const confirmations = [], sent = [];
  const source = fs.readFileSync(path.join(__dirname, '../../extension/src/content/contentRuntime.js'), 'utf8');
  const start = source.indexOf('    preflightProjectReferences:', source.indexOf('const writingStyleSettings ='));
  if (start < 0) throw new Error('Production WritingStyleSettings preflight dependency is missing');
  const end = source.indexOf('    startBuild:', start);
  const callback = source.slice(start + '    preflightProjectReferences:'.length, end).trim().replace(/,$/, '');
  const preflight = vm.runInNewContext('(' + callback + ')', {
    Modules: { SensitivePreflight }, SensitiveScan, normalizeGovernanceRules, isTextSnapshotFile: file => typeof file.content === 'string',
    getGovernanceRulesForCurrentProject: () => rules, getCurrentProjectId: () => scope.projectId,
    tx, tr: key => key, showPluginConfirm: async value => { confirmations.push(value); await onConfirm?.(); return approve; }
  });
  const ctl = Settings.create({ tx, getScope: () => scope, request: async () => ({ ok: true, result: metadata || { enabled: false, ready: false, sources: [], snapshot: null } }),
    isRunning: () => false, cancelReferenceRead: async () => {}, getModelSettings: async () => ({}), preflightProjectReferences: preflight,
    listProjects: async () => [{ projectId: 'reference-one', name: 'Reference one', archived: false }],
    getReferenceSnapshot: async () => ({ projectId: 'reference-one', capturedAt: new Date().toISOString(), capabilities: { referenceTextComplete: true },
      files: [{ path: 'main.tex', content: 'Synthetic prose.\n' + marker }] }),
    startBuild: async value => { sent.push(value); return { id: 'synthetic-request', promise: Promise.resolve({ ok: false, error: buildError || { message: 'Synthetic model boundary reached.' } }) }; }, ...overrides });
  ctl.mount(panel); await ctl.ensureLoaded();
  const changeLocale = value => { locale = value; ctl.sync(); };
  if (initializeOnly) return { ctl, host, changeLocale };
  const toggle = host.querySelector('[data-style-focus="enable-style"]'); toggle.checked = true; toggle.dispatch('change'); await flush();
  const checkbox = host.querySelector('[data-style-focus="project-reference-one"]'); checkbox.checked = true; checkbox.dispatch('change');
  return { ctl, host, sent, confirmations, changeLocale, scope: value => { scope = value; },
    generate: async () => { host.querySelector('[data-style-focus="generate-style"]').dispatch('click'); await flush(); } };
}
module.exports = { harness, flush };
