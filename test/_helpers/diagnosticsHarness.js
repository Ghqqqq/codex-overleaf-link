'use strict';

// Runs production diagnostic modules and mechanically extracted runtime wiring.
// DOM, Chrome runtime replies and Page transport are controlled test boundaries.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const { extractFunction } = require(path.join(repo, 'test/_helpers/extractFunction'));
const Compatibility = require(path.join(repo, 'extension/src/shared/compatibility'));
const ProjectFiles = require(path.join(repo, 'extension/src/shared/projectFiles'));
const I18n = require(path.join(repo, 'extension/src/shared/i18n'));
const NativeChannel = require(path.join(repo, 'extension/src/content/nativeChannel'));
const NativeCompatibilityController = require(path.join(repo, 'extension/src/content/nativeCompatibilityController'));
const source = file => fs.readFileSync(path.join(repo, file), 'utf8');
const runtimeFile = 'extension/src/content/contentRuntime.js';
const runtime = source(runtimeFile);
const controllerFile = 'extension/src/content/diagnosticsController.js';
const panelFile = 'extension/src/content/diagnosticsPanel.js';
function exactSlice(startMarker, endMarker, includeEnd = true) {
  const start = runtime.indexOf(startMarker);
  const end = runtime.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return runtime.slice(start, end + (includeEnd ? endMarker.length : 0));
}
const panelWiring = exactSlice('      diagnosticsPanelInstance = DiagnosticsPanel.create({', '\n\n      settingsPanelInstance =', false).trim();
const controllerWiring = exactSlice('  const diagnosticsController = Modules.DiagnosticsController.create({', '  } = diagnosticsController;');
const nativeGates = exactSlice('  const NATIVE_COMPATIBILITY_GATED_METHODS = new Set([', '  ]);');
const functionNames = ['closeDiagnosticsMenu', 'closeDiagnosticsResult', 'showDiagnosticsLoading', 'showDiagnosticsResult',
  'setDiagnosticsHealth', 'sendBackgroundNative', 'callPageBridge', 'formatProbeStatusBar', 'getProbeRunReadiness',
  'appendOtStatusToProbeStatus', 'formatModeLabel', 'formatProjectSnapshotLog', 'formatProjectSnapshotFileSize', 'formatProjectSnapshotWarning',
  'getProjectSnapshotWarnings', 'isTextSnapshotFile', 'uniqueContentSignatures'];
const runtimeFunctions = functionNames.map(name => extractFunction(runtime, name)).join('\n');

class EventSurface {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, event) { for (const handler of this.listeners.get(type) || []) handler(event); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
class Element extends EventSurface {
  constructor(tag, doc) {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = [];
    this.parentElement = null; this.attributes = {}; this.dataset = {}; this.style = {};
    this.hidden = false; this.disabled = false; this.open = false; this.isConnected = true; this._text = '';
  }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'class') this.className = String(value);
    if (key === 'id') this.id = String(value);
    if (key === 'hidden') this.hidden = true;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  matches(selector) {
    if (selector.startsWith('.')) return (this.className || '').split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return Object.hasOwn(this.attributes, attr[1]) && (attr[2] === undefined || this.attributes[attr[1]] === attr[2]);
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let item = this; item; item = item.parentElement) if (item.matches(selector)) return item; return null; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  focus() { this.ownerDocument.activeElement = this; }
  getClientRects() { return [{ left: 840, right: 920, top: 20, bottom: 40, width: 80, height: 20 }]; }
  getBoundingClientRect() {
    if (this.id === 'codex-overleaf-panel') return { left: 650, right: 1000, top: 0, bottom: 800, width: 350, height: 800 };
    return { left: 840, right: 920, top: 20, bottom: 40, width: Number.parseFloat(this.style.width) || 80, height: 160 };
  }
  click() {
    for (let item = this; item; item = item.parentElement) assert.equal(item.hidden, false, 'click must be on an exposed fixture element');
    assert.equal(this.disabled, false);
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    this.ownerDocument.dispatch('click', event);
    this.dispatch('click', event);
  }
  set innerHTML(html) {
    this._text = ''; this.children = [];
    const stack = [this];
    for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)?.[1];
        if (!tag) continue;
        const node = new Element(tag, this.ownerDocument);
        for (const match of token.slice(tag.length + 1, token.length - 1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.setAttribute(match[1], match[2] ?? '');
        stack[stack.length - 1].append(node);
        if (!token.endsWith('/>') && !['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
      } else if (token.trim()) stack[stack.length - 1]._text += token.trim();
    }
    assert.equal(stack.length, 1, 'static production markup must balance');
  }
}
function deferred() {
  let complete, reject; const entry = { settled: false };
  entry.promise = new Promise((done, fail) => { complete = done; reject = fail; });
  entry.resolve = value => { entry.settled = true; complete(value); };
  entry.reject = error => { entry.settled = true; reject(error); };
  return entry;
}
async function flushUntil(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await Promise.resolve(); }
  assert.ok(predicate(), 'controlled microtasks should settle without wall-clock sleeps');
}

function harness(options = {}) {
  const document = new EventSurface();
  const window = new EventSurface();
  Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
  document.defaultView = window; document.createElement = tag => new Element(tag, document);
  const panel = document.createElement('div'); panel.setAttribute('id', 'codex-overleaf-panel');
  const container = document.createElement('div'); panel.append(container);
  const requests = [], diagnosticReplies = [], trace = [], pageGates = [], operations = [];
  let projectId = 'synthetic-project';
  const metadata = { version: '2.5.0', extensionId: 'illdpneeeopfffmiepaejglgmhpmdhdc' };
  const healthy = { ok: true, result: { version: '2.5.0', protocolVersion: 2, supportedProtocol: { min: 1, max: 2 },
    capabilities: Object.fromEntries(Compatibility.buildBridgePingParams(metadata).requiredCapabilities.map(key => [key, true])),
    environment: { codex: { ok: true, path: 'synthetic-codex' }, latex: { available: ['synthetic-latexmk'] } } } };
  let nextId = 0;
  const chrome = { runtime: { sendMessage(message) {
    assert.equal(message.type, 'codex-overleaf/native-request');
    assert.equal(message.payload.method, 'bridge.ping');
    const ordinal = requests.length;
    requests.push(JSON.parse(JSON.stringify(message)));
    trace.push({ type: 'native-dispatch', ordinal, id: message.payload.id, phase: ordinal % 2 ? 'diagnostic-ping' : 'compatibility-ping' });
    if (ordinal % 2 === 0) return Promise.resolve(healthy);
    const pending = deferred(); diagnosticReplies.push(pending); return pending.promise;
  } } };
  const nativeChannel = NativeChannel.create({ chrome, crypto: { randomUUID: () => 'synthetic-request-' + (++nextId) } });
  const context = vm.createContext({ window, document, chrome, console, Promise, Set, Map, Date, JSON,
    Modules: { Compatibility, ProjectFiles }, CodexOverleafCompatibility: Compatibility,
    tr: (key, params) => I18n.t('en', key, params), tx: en => en,
    getExtensionCompatibilityMetadata: () => metadata,
    state: { mode: 'ask', requireReviewing: false }, cachedAccountScopeId: 'synthetic-account', spaRouteGeneration: 1,
    getCurrentProjectId: () => projectId, getActiveFocusFiles: () => [],
    isExperimentalOtEnabled: () => options.otEnabled === true, getOtWarmMirrorState: () => ({}),
    getCurrentOtStatus: () => 'observing', otWarmMirrorController: { canUseOtWarmStart: () => ({ ok: true }) },
    readOtBridgeStatus: value => value.status,
    formatOtStatusLabel: String, normalizeOtStatus: value => value,
    getMirrorFreshness: async () => ({ otFreshFileCount: 1 }),
    INSTALL_COMMAND: 'synthetic-install-command', RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 90000,
    closeModelConfigPopover() {}, closeContextTray() {}, closeCustomInstructionsSettings() {},
    exportDiagnosticsBundle() { throw Error('export is outside this probe'); }, showPluginToast() { throw Error('unexpected toast'); },
    panelRendererInstance: { diagnosticsSlot: container },
    pageBridgeClient: { async call(method, params) {
      trace.push({ type: 'page-request', method, params: JSON.parse(JSON.stringify(params)) });
      const gate = pageGates.find(item => !item.used && item.method === method);
      if (gate) { gate.used = true; return gate.promise; }
      if (method === 'probe') return { projectId, editor: { ok: true }, reviewing: { ok: true }, capabilities: { editor: { write: true } } };
      if (method === 'getProjectSnapshot') return { projectId, activePath: 'main.tex',
        files: [{ path: 'main.tex', content: 'Synthetic safe fixture prose describing controlled diagnostics and independent responses. '.repeat(3) }],
        capabilities: { fullProjectSnapshot: true, method: 'synthetic-transport' } };
      if (method === 'getOtStatus') return { ok: true, status: 'observing' };
      throw Error('Unexpected page method: ' + method);
    } }
  });
  let accountScopeId = context.cachedAccountScopeId;
  Object.defineProperty(context, 'cachedAccountScopeId', {
    configurable: true,
    get() { options.onScopeRead?.(); return accountScopeId; },
    set(value) { accountScopeId = value; }
  });
  vm.runInContext(source(panelFile), context, { filename: panelFile });
  vm.runInContext(source(controllerFile), context, { filename: controllerFile });
  context.DiagnosticsPanel = window.CodexOverleafDiagnosticsPanel;
  context.Modules.DiagnosticsController = { create(deps) {
    const controller = window.CodexOverleafDiagnosticsController.create(deps);
    // Observe top-level promises without changing arguments, resolution or the
    // production controller's internal collectOnly calls.
    return Object.fromEntries(Object.entries(controller).map(([key, value]) => [key,
      /^(?:runAllDiagnostics|inspect)/.test(key) ? (...args) => {
        const promise = value(...args); const operation = { method: key, promise };
        operations.push(operation); return promise;
      } : value]));
  } };
  vm.runInContext(nativeGates, context, { filename: 'runtime-native-gates.extracted.js' });
  context.nativeCompatibilityController = NativeCompatibilityController.create({
    compatibility: Compatibility, nativeChannel,
    gatedMethods: vm.runInContext('NATIVE_COMPATIBILITY_GATED_METHODS', context),
    getExtensionCompatibilityMetadata: () => metadata,
    tx: en => en, tr: context.tr,
    throwIfCancellationRequested() { throw Error('bridge.ping must remain ungated'); }
  });
  vm.runInContext('let diagnosticsPanelInstance;\n' + runtimeFunctions + '\n' + controllerWiring + '\n' + panelWiring +
    '\nglobalThis.fixture = { diagnosticsPanelInstance, diagnosticsController };', context, { filename: 'runtime-diagnostics-wiring.extracted.js' });
  const control = selector => { const node = container.querySelector(selector); assert.ok(node, selector); return node; };
  function snapshot() {
    const root = control('[data-diagnostics-result]');
    const rows = root.querySelectorAll('.codex-diagnostics-check').map(row => ({ status: row.dataset.status, open: row.open,
      title: row.querySelector('.codex-diagnostics-check-title')?.textContent || '',
      summary: row.querySelector('.codex-diagnostics-check-summary')?.textContent || '',
      next: row.querySelector('.codex-diagnostics-check-next')?.textContent || '' }));
    return { hidden: root.hidden, status: root.dataset.status || '', title: control('[data-diagnostics-result-title]').textContent,
      subtitle: control('[data-diagnostics-result-subtitle]').textContent,
      bodyText: control('[data-diagnostics-result-body]').textContent, rows,
      health: control('[data-diagnostics-health-dot]').dataset.health,
      healthTooltip: control('[data-diagnostics-menu]').title || '',
      dismissed: context.fixture.diagnosticsPanelInstance._instance.resultDismissed,
      menuHidden: control('[data-diagnostics-popover]').hidden,
      visibleRowText: root.hidden ? [] : rows.map(row => row.title + (row.open ? ' ' + row.summary + ' ' + row.next : '')) };
  }
  async function start(kind = 'all') {
    if (control('[data-diagnostics-popover]').hidden) control('[data-diagnostics-menu]').click();
    if (control('[data-diagnostics-popover]').hidden) control('[data-diagnostics-menu]').click();
    assert.equal(control('[data-diagnostics-popover]').hidden, false);
    const previous = operations.length;
    const selector = { all: 'run-all', native: 'native-env', page: 'page-state', snapshot: 'snapshot', ot: 'ot' }[kind];
    assert.ok(selector);
    control('[data-diagnostics-' + selector + ']').click();
    assert.equal(operations.length, previous + 1);
    const operation = operations.at(-1);
    if (kind === 'all' || kind === 'native') {
      await flushUntil(() => diagnosticReplies.length === operations.filter(item => ['runAllDiagnostics', 'inspectNativeEnvironment'].includes(item.method)).length);
      operation.nativeIndex = diagnosticReplies.length - 1;
    }
    return operation;
  }
  function resolve(index, ok) {
    const response = JSON.parse(JSON.stringify(healthy));
    response.result.environment.codex.ok = ok;
    diagnosticReplies[index].resolve(response);
    trace.push({ type: 'resolve-diagnostic', index, codexOk: ok });
  }
  function destroy() {
    context.fixture.diagnosticsPanelInstance.destroy();
    assert.equal(document.listenerCount(), 0);
    assert.equal(window.listenerCount(), 0);
    assert.equal(container.children.length, 0);
    assert.ok(diagnosticReplies.every(reply => reply.settled));
    assert.equal(nativeChannel.getActiveRequestId(), null);
    assert.ok(pageGates.every(gate => !gate.used || gate.settled));
  }
  return { start, resolve, snapshot, requests, trace, destroy,
    holdPage(method) { const gate = Object.assign(deferred(), { method, used: false }); pageGates.push(gate); return gate; },
    changeScope(changes) {
      if (Object.hasOwn(changes, 'accountScopeId')) context.cachedAccountScopeId = changes.accountScopeId;
      if (Object.hasOwn(changes, 'projectId')) projectId = changes.projectId;
      if (Object.hasOwn(changes, 'generation')) context.spaRouteGeneration = changes.generation;
    },
    close() { control('[data-diagnostics-result-close]').click(); },
    async settled(status, expectedPageRequests) {
      try { await flushUntil(() => snapshot().status === status && trace.filter(item => item.type === 'page-request').length === expectedPageRequests); }
      catch (error) { throw new Error(error.message + '\n' + JSON.stringify({ snapshot: snapshot(), trace })); }
    }
  };
}


module.exports = { harness, flushUntil };
