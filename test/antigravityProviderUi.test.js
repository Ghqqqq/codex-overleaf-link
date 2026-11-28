'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ProviderProfiles = require('../extension/src/shared/providerProfiles');
const AgentBrand = require('../extension/src/shared/agentBrand');
const RunExecutionSnapshot = require('../extension/src/shared/runExecutionSnapshot');
const FailureReasons = require('../extension/src/shared/failureReasons');
const AgentTranscript = require('../extension/src/shared/agentTranscript');
const RunActivityModel = require('../extension/src/shared/runActivityModel');
const Compatibility = require('../extension/src/shared/compatibility');
const I18n = require('../extension/src/shared/i18n');
const Models = require('../extension/src/shared/models');
const ModelPickerSupport = require('../extension/src/content/modelPickerSupport');
const RunController = require('../extension/src/content/runController');
const RunPresence = require('../extension/src/content/runPresence');
const RunCompletionMeta = require('../extension/src/content/runCompletionMeta');
const RunFailureNotice = require('../extension/src/content/runFailureNotice');
const RunTimelineView = require('../extension/src/content/runTimelineView');
const NativeCompatibilityController = require('../extension/src/content/nativeCompatibilityController');
const RunQueueScheduler = require('../extension/src/content/runQueueScheduler');
const PendingInputView = require('../extension/src/content/pendingInputView');
const RunResultActions = require('../extension/src/content/runResultActions');
const SessionForkController = require('../extension/src/content/sessionForkController');
const LocalSkillsPanel = require('../extension/src/content/localSkillsPanel');

function loadBrowserModule(relPath, extraGlobals = {}) {
  const filename = path.join(__dirname, '..', relPath);
  const windowObj = extraGlobals.window || {};
  const sandbox = {
    window: windowObj,
    globalThis: windowObj,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URL,
    ...extraGlobals
  };
  sandbox.window = windowObj;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return windowObj;
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.childNodes = this.children;
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.title = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this._textContent = '';
    this._innerHTML = '';
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(n => set.add(n));
        this.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        names.forEach(n => set.delete(n));
        this.className = [...set].join(' ');
      },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  get textContent() { return this._textContent || this.children.map(c => c.textContent || '').join(''); }
  set textContent(v) {
    this._textContent = String(v ?? '');
    if (this._textContent === '') this.children = [];
    this.childNodes = this.children;
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) {
    this._innerHTML = String(v ?? '');
    this.children = [];
    this.childNodes = this.children;
    const tagRe = /<([a-z0-9-]+)([^>]*)>/gi;
    let match;
    while ((match = tagRe.exec(this._innerHTML))) {
      const [, tag, attrs] = match;
      if (tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' || tag === 'g') continue;
      const child = new FakeElement(tag);
      const cls = /\bclass="([^"]*)"/.exec(attrs);
      if (cls) child.className = cls[1];
      for (const d of attrs.matchAll(/\b(data-[a-z0-9-]+)(?:="([^"]*)")?/gi)) {
        child.setAttribute(d[1], d[2] ?? '');
      }
      child.parentElement = this;
      this.children.push(child);
    }
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get lastElementChild() { return this.lastChild; }
  get nextSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx >= 0 ? (this.parentElement.children[idx + 1] || null) : null;
  }
  get options() { return this.children.filter(c => c.tagName === 'OPTION'); }
  get selectedIndex() { return this.options.findIndex(o => o.value === this.value); }
  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      if (typeof node === 'string') {
        this._textContent += node;
        continue;
      }
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (node == null || typeof node === 'string') continue;
      if (node.parentElement) node.remove();
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  insertBefore(node, ref) {
    if (node.parentElement) node.remove();
    node.parentElement = this;
    const idx = ref ? this.children.indexOf(ref) : -1;
    if (idx < 0) this.children.push(node);
    else this.children.splice(idx, 0, node);
    return node;
  }
  before(...nodes) {
    if (!this.parentElement) return;
    for (const node of nodes) if (node && typeof node !== 'string') this.parentElement.insertBefore(node, this);
  }
  after(...nodes) {
    if (!this.parentElement) return;
    const ref = this.nextSibling;
    for (const node of nodes) if (node && typeof node !== 'string') this.parentElement.insertBefore(node, ref);
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.childNodes = this.children; this._textContent = ''; this.append(...nodes); }
  replaceWith(node) {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) {
      node.parentElement = this.parentElement;
      this.parentElement.children[idx] = node;
    }
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(c => c !== this);
    this.parentElement.childNodes = this.parentElement.children;
    this.parentElement = null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  dispatchEvent(event) {
    for (const fn of this._listeners.get(event.type) || []) fn(event);
  }
  cloneNode() {
    const copy = new FakeElement(this.tagName);
    copy.className = this.className;
    copy.dataset = { ...this.dataset };
    for (const [k, v] of this.attributes) copy.attributes.set(k, v);
    return copy;
  }
  matches(selector) {
    return selector.split(',').map(s => s.trim()).some(part => {
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const attrMatch = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(part);
      if (attrMatch) {
        const key = attrMatch[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (!(key in this.dataset)) return false;
        return attrMatch[2] === undefined || this.dataset[key] === attrMatch[2];
      }
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

function createFakeDocument() {
  return {
    createElement: tag => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag)
  };
}

test('ProviderProfiles and RunExecutionSnapshot treat antigravity as a fixed revision-0 provider', () => {
  const withoutAgy = ProviderProfiles.normalizeCatalog({ providers: [] });
  assert.deepEqual(withoutAgy.providers.map(p => p.id), ['builtin']);
  assert.equal(ProviderProfiles.getProviderById(withoutAgy, 'antigravity'), null);

  const withAgy = ProviderProfiles.normalizeCatalog({
    activeProviderId: 'antigravity',
    providers: [
      { id: 'builtin', kind: 'builtin' },
      { id: 'antigravity', kind: 'antigravity', revision: 9, name: 'Tampered', editable: true, deletable: true, baseUrl: 'https://evil.example' },
      { id: 'custom-1', kind: 'custom', revision: 3, name: 'Custom', baseUrl: 'https://api.example/v1', models: [{ id: 'm1' }] }
    ]
  });
  const agy = ProviderProfiles.getProviderById(withAgy, 'antigravity');
  assert.deepEqual(agy, {
    id: 'antigravity',
    kind: 'antigravity',
    revision: 0,
    name: 'Antigravity',
    editable: false,
    deletable: false,
    models: []
  });
  assert.deepEqual(ProviderProfiles.buildRunSelection(withAgy, 'antigravity'), {
    providerId: 'antigravity',
    providerRevision: 0
  });

  const snapshot = RunExecutionSnapshot.create({
    mode: 'auto',
    providerId: 'antigravity',
    providerRevision: 0,
    model: 'gemini-4-neon',
    reasoningEffort: 'high',
    speedTier: 'standard'
  });
  assert.deepEqual(RunExecutionSnapshot.toProviderSelection(snapshot), {
    providerId: 'antigravity',
    providerRevision: 0
  });
  const resolved = RunExecutionSnapshot.resolveForExecution(snapshot, { catalog: withAgy });
  assert.deepEqual(RunExecutionSnapshot.toProviderSelection(resolved), {
    providerId: 'antigravity',
    providerRevision: 0
  });

  // Missing from catalog (e.g. older Native host) fails closed.
  assert.throws(
    () => RunExecutionSnapshot.resolveForExecution(snapshot, { catalog: withoutAgy }),
    { code: 'provider_not_found' }
  );
  // Non-zero revision is rejected for fixed antigravity provider.
  assert.throws(
    () => RunExecutionSnapshot.create({ mode: 'ask', providerId: 'antigravity', providerRevision: 2 }),
    { code: 'provider_revision_conflict' }
  );
  // Custom providers still require a positive revision.
  assert.throws(
    () => RunExecutionSnapshot.create({ mode: 'ask', providerId: 'custom-1', providerRevision: '' }),
    { code: 'provider_revision_conflict' }
  );

  // Queued skill scoping follows the queued payload's captured provider, not the current panel provider.
  const codexQueuedPayload = RunExecutionSnapshot.toQueuePayload(
    RunExecutionSnapshot.create({ mode: 'ask', providerId: 'builtin', model: 'gpt-5.4' })
  );
  const codexQueuedScope = RunController.resolveRunSkillScope({
    queuedInput: { payload: codexQueuedPayload },
    queuedSnapshot: RunExecutionSnapshot.fromQueuePayload(codexQueuedPayload),
    panelProviderId: 'antigravity',
    submittedEnabledSkillIds: ['annotated-rewrite'],
    submittedEnabledLocalSkillIds: ['local-1'],
    submittedSkillInvocation: { id: 'local-1', scope: 'codex-local', title: 'Local' }
  });
  assert.equal(codexQueuedScope.antigravityRun, false);
  assert.deepEqual(codexQueuedScope.enabledCodexOverleafSkillIds, ['annotated-rewrite']);
  assert.deepEqual(codexQueuedScope.enabledCodexLocalSkillIds, ['local-1']);
  assert.equal(codexQueuedScope.skillInvocation.id, 'local-1');
  assert.equal(codexQueuedScope.blockedSkillInvocation, null);

  const agyQueuedPayload = RunExecutionSnapshot.toQueuePayload(
    RunExecutionSnapshot.create({ mode: 'ask', providerId: 'antigravity', providerRevision: 0, model: 'gemini-4-neon' })
  );
  const agyQueuedScope = RunController.resolveRunSkillScope({
    queuedInput: { payload: agyQueuedPayload },
    queuedSnapshot: RunExecutionSnapshot.fromQueuePayload(agyQueuedPayload),
    panelProviderId: 'builtin',
    submittedEnabledSkillIds: ['annotated-rewrite'],
    submittedEnabledLocalSkillIds: ['local-1'],
    submittedSkillInvocation: { id: 'skill-installer', title: 'Skill Installer' }
  });
  assert.equal(agyQueuedScope.antigravityRun, true);
  assert.deepEqual(agyQueuedScope.enabledCodexOverleafSkillIds, []);
  assert.deepEqual(agyQueuedScope.enabledCodexLocalSkillIds, []);
  assert.equal(agyQueuedScope.skillInvocation, null);
  assert.equal(agyQueuedScope.blockedSkillInvocation.id, 'skill-installer');
});

test('NativeCompatibilityController exposes antigravityRuntime capability and coordinator gates list, login, refresh, and activation', async () => {
  let nativeSupportsAntigravity = false;
  const nativeCalls = [];
  const compat = NativeCompatibilityController.create({
    gatedMethods: new Set(['codex.providers.list', 'codex.providers.antigravity.status', 'codex.providers.antigravity.login', 'codex.providers.activate']),
    fallbackNativeCompatibility: response => ({
      status: 'ok',
      native: response?.result || {}
    }),
    nativeChannel: {
      async sendBackgroundNative(payload) {
        nativeCalls.push(payload.method);
        if (payload.method === 'bridge.ping') {
          return {
            ok: true,
            result: {
              version: '2.6.8',
              capabilities: nativeSupportsAntigravity ? { antigravityRuntime: true } : {}
            }
          };
        }
        return { ok: true, result: {} };
      }
    }
  });

  await compat.ensureForMethod('codex.providers.list');
  assert.equal(compat.hasCapability('antigravityRuntime'), false);

  // Stub dialog to observe coordinator interactions without needing full browser DOM.
  let dialogCatalog = null;
  let dialogAntigravityState = {};
  let dialogBusy = [];
  let dialogStatuses = [];
  let dialogOpen = true;
  let selectedProviderId = 'builtin';
  let committed = null;
  const modelLoads = [];
  const rpcCalls = [];
  let statusResponse = { installed: true, executable: '/usr/local/bin/agy', version: '1.5.18', signedIn: false, tier: null, error: null };

  const DialogStub = {
    create(opts) {
      return {
        open(catalog) { dialogOpen = true; dialogCatalog = catalog; },
        close() { dialogOpen = false; return true; },
        setCatalog(catalog) { dialogCatalog = catalog; },
        offerCatalog(catalog) { dialogCatalog = catalog; return true; },
        setBusy(kind, msg) { dialogBusy.push({ kind, msg }); },
        setStatus(s) { dialogStatuses.push(s); },
        setAntigravityStatus(next) { dialogAntigravityState = { ...dialogAntigravityState, ...next }; },
        isOpen: () => dialogOpen,
        destroy() {},
        _opts: opts,
        _instance: { selectedId: 'builtin' }
      };
    }
  };

  const coordWin = loadBrowserModule('extension/src/content/providerSettingsCoordinator.js', {
    document: createFakeDocument()
  });
  const coordinator = coordWin.CodexOverleafProviderSettingsCoordinator.create({
    document: createFakeDocument(),
    ProviderProfiles,
    ProviderSettingsDialog: DialogStub,
    hasCurrentProject: () => true,
    hasAntigravityRuntime: () => compat.hasCapability('antigravityRuntime'),
    getSelectedProviderId: () => selectedProviderId,
    setSelectedProviderId: (id, model) => { selectedProviderId = id; committed = { id, model }; },
    confirmProviderSwitch: async () => true,
    refreshModelOptions: async selection => {
      modelLoads.push(selection);
      return { stale: false, selectedModel: 'gemini-4-neon' };
    },
    sendBackgroundNative: async ({ method, params }) => {
      rpcCalls.push({ method, params });
      if (method === 'codex.providers.list') {
        return {
          ok: true,
          result: {
            activeProviderId: 'builtin',
            storeRevision: 1,
            providers: [
              { id: 'builtin', kind: 'builtin' },
              { id: 'antigravity', kind: 'antigravity', revision: 0, name: 'Antigravity', editable: false, deletable: false, models: [] }
            ]
          }
        };
      }
      if (method === 'codex.providers.antigravity.status') {
        return { ok: true, result: statusResponse };
      }
      if (method === 'codex.providers.antigravity.login') {
        statusResponse = { installed: true, executable: '/usr/local/bin/agy', version: '1.5.18', signedIn: true, tier: { name: 'Google AI Ultra', id: 'ultra' }, error: null };
        return { ok: true, result: statusResponse };
      }
      if (method === 'codex.providers.activate') {
        return {
          ok: true,
          result: {
            activeProviderId: params.providerId,
            storeRevision: 2,
            providers: [
              { id: 'builtin', kind: 'builtin' },
              { id: 'antigravity', kind: 'antigravity', revision: 0, name: 'Antigravity', editable: false, deletable: false, models: [] }
            ]
          }
        };
      }
      return { ok: false, error: { code: 'unknown' } };
    }
  });

  // Without antigravityRuntime capability, antigravity is stripped and activation is refused.
  await coordinator.open();
  assert.equal(coordinator.isProviderAvailable('antigravity'), false);
  assert.equal(dialogCatalog.providers.some(p => p.id === 'antigravity'), false);
  await coordinator.activateAntigravity();
  assert.equal(rpcCalls.some(c => c.method === 'codex.providers.activate'), false);

  // Now enable capability on bridge.ping and reopen.
  nativeSupportsAntigravity = true;
  await compat.ensureForMethod('codex.providers.list');
  assert.equal(compat.hasCapability('antigravityRuntime'), true);

  await coordinator.open();
  assert.equal(coordinator.isProviderAvailable('antigravity'), true);
  assert.equal(dialogCatalog.providers.some(p => p.id === 'antigravity'), true);

  // Refresh status (signed out), then sign in (in-progress -> refreshes status -> signed in with tier).
  const initialStatus = await coordinator.refreshAntigravityStatus();
  assert.equal(initialStatus.signedIn, false);
  assert.equal(dialogAntigravityState.status.signedIn, false);

  dialogBusy = [];
  const afterLogin = await coordinator.loginAntigravity();
  assert.equal(afterLogin.signedIn, true);
  assert.equal(afterLogin.tier.name, 'Google AI Ultra');
  assert.ok(dialogBusy.some(entry => entry.kind === 'antigravity-login'));
  assert.equal(rpcCalls.filter(c => c.method === 'codex.providers.antigravity.login').length, 1);
  assert.equal(rpcCalls.filter(c => c.method === 'codex.providers.antigravity.status').length, 2);

  // Activate Antigravity: preloads Gemini models with providerSelection {antigravity, 0}, calls activate, commits project selection.
  await coordinator.activateAntigravity();
  assert.deepEqual(modelLoads[0], { providerId: 'antigravity', providerRevision: 0 });
  const activateCall = rpcCalls.find(c => c.method === 'codex.providers.activate');
  assert.deepEqual({ ...activateCall.params }, { providerId: 'antigravity', expectedRevision: 0 });
  assert.deepEqual(committed, { id: 'antigravity', model: 'gemini-4-neon' });
});

test('ModelPicker lists Gemini models and efforts for Antigravity and does not fall back to GPT on auth error', async () => {
  const doc = createFakeDocument();
  const panel = doc.createElement('div');
  const modelSelect = doc.createElement('select'); modelSelect.dataset.model = '';
  const reasoningSelect = doc.createElement('select'); reasoningSelect.dataset.reasoning = '';
  const speedSelect = doc.createElement('select'); speedSelect.dataset.speed = '';
  const modelDisplay = doc.createElement('span'); modelDisplay.dataset.modelDisplay = '';
  const reasoningDisplay = doc.createElement('span'); reasoningDisplay.dataset.reasoningDisplay = '';
  const modelChoices = doc.createElement('div'); modelChoices.dataset.modelChoiceList = '';
  const reasoningChoices = doc.createElement('div'); reasoningChoices.dataset.reasoningChoiceList = '';
  const speedChoices = doc.createElement('div'); speedChoices.dataset.speedChoiceList = '';
  panel.append(modelSelect, reasoningSelect, speedSelect, modelDisplay, reasoningDisplay, modelChoices, reasoningChoices, speedChoices);

  const pickerWin = loadBrowserModule('extension/src/content/modelPicker.js', { document: doc });
  let mockResponse = {
    ok: true,
    result: {
      providerId: 'antigravity',
      providerRevision: 0,
      providerName: 'Antigravity',
      source: 'antigravity',
      defaultModelId: 'gemini-4-neon',
      models: [
        { id: 'gemini-4-neon', label: 'Gemini 4 Neon', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'high', reasoningPresentation: 'effort', speedTiers: ['standard'], defaultSpeedTier: 'standard' },
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', reasoningPresentation: 'effort', speedTiers: ['standard'], defaultSpeedTier: 'standard' }
      ],
      fetchedAt: '2026-11-27T00:00:00.000Z'
    }
  };
  const picker = pickerWin.CodexOverleafModelPicker.create({
    Support: ModelPickerSupport,
    tr: key => key,
    tx: en => en,
    getLocale: () => 'en',
    sendBackgroundNative: async () => mockResponse,
    getProviderSelection: () => ({ providerId: 'antigravity', providerRevision: 0 }),
    readSelectedSpeedInput: () => speedSelect.value || 'standard',
    getRenderedModelEntries: () => ModelPickerSupport.getRenderedModelEntries(panel),
    persistPanelInputs: async () => {},
    getPanel: () => panel,
    getState: () => ({ providerId: 'antigravity', model: '', reasoningEffort: '', speedTier: 'standard' })
  });

  const loaded = await picker.loadModelOptions({ providerId: 'antigravity', providerRevision: 0 }, { persist: false });
  assert.equal(loaded.stale, false);
  assert.equal(loaded.selectedModel, 'gemini-4-neon');
  assert.deepEqual(modelSelect.options.map(o => o.value), ['gemini-4-neon', 'gemini-3.8-flash']);
  assert.deepEqual(reasoningSelect.options.map(o => o.value), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoningSelect.value, 'high');
  assert.equal(speedSelect.disabled, true);
  assert.equal(picker.getModelDiscovery().source, 'antigravity');

  // Signed-out failure must NOT fall back to built-in GPT models.
  mockResponse = { ok: false, error: { code: 'antigravity_auth_required', message: 'Authentication required' } };
  const failed = await picker.loadModelOptions({ providerId: 'antigravity', providerRevision: 0 }, { persist: false });
  assert.equal(failed.error.code, 'antigravity_auth_required');
  assert.equal(modelSelect.disabled, true);
  assert.equal(modelSelect.options.some(o => o.value.startsWith('gpt-')), false);
  assert.equal(picker.getModelDiscovery().errorCode, 'antigravity_auth_required');
});

test('Codex-only features (steer, fork, local skills, parallel-subagents) are gated cleanly under Antigravity', async () => {
  const doc = createFakeDocument();
  const tr = key => I18n.t('en', key);

  // 1. Steer is disabled and keeps guidance queued for next turn without calling sendSteer.
  let queue = [{ id: 'item-1', text: 'Next turn guidance', status: 'queued', createdAt: 1, clientUserMessageId: 'u1' }];
  let steerCalls = 0;
  const toasts = [];
  const container = doc.createElement('div');
  const prevDoc = globalThis.document;
  globalThis.document = doc;
  try {
    const coordinator = RunQueueScheduler.createCoordinator({
      getActiveSession: () => ({ id: 's1', createdAt: 1, pendingInputs: queue }),
      getSession: () => ({ id: 's1', createdAt: 1, pendingInputs: queue }),
      setQueue: (_sid, next) => { queue = next; },
      getCurrentRun: () => ({
        recordId: 'r1',
        sessionId: 's1',
        providerId: 'antigravity',
        executionSnapshot: { providerId: 'antigravity' },
        activeTurn: { threadId: 'agy:sess-1', turnId: 'turn-1' }
      }),
      isGuideSupported: run => (run?.executionSnapshot?.providerId || run?.providerId) !== 'antigravity',
      sendSteer: async () => { steerCalls += 1; return { ok: true }; },
      getContainer: () => container,
      createView: opts => PendingInputView.create(opts),
      toast: (msg, status) => toasts.push({ msg, status }),
      tr
    });
    coordinator.render();
    const guideBtn = container.querySelector('[data-action="guide"]');
    assert.ok(guideBtn);
    assert.equal(guideBtn.disabled, true);
    assert.equal(guideBtn.title, tr('queuedInputGuideUnsupportedAntigravity'));

    await coordinator.guide('item-1');
    assert.equal(steerCalls, 0);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].status, 'queued');
    assert.equal(toasts[0].msg, tr('queuedInputGuideUnsupportedAntigravity'));

    // 2. Fork button is disabled for Antigravity runs and SessionForkController rejects early.
    const card = doc.createElement('article');
    const report = doc.createElement('div'); report.className = 'run-completion-report';
    const actions = doc.createElement('div'); actions.className = 'run-result-actions';
    const copyBtn = doc.createElement('button'); copyBtn.dataset.runCopy = '';
    const forkBtn = doc.createElement('button'); forkBtn.dataset.runFork = '';
    actions.append(copyBtn, forkBtn);
    card.append(report, actions);
    const resultActions = RunResultActions.create({
      tr,
      document: doc,
      getActiveProviderId: () => 'antigravity',
      forkRunFromNode: async () => {}
    });
    resultActions.configureResultActions(card, {
      id: 'run-1',
      status: 'completed',
      providerId: 'antigravity',
      codexThreadId: 'agy:sess-1',
      codexTurnId: 'turn-1'
    });
    const renderedForkBtn = card.querySelector('[data-run-fork]');
    assert.equal(renderedForkBtn.disabled, true);
    assert.equal(renderedForkBtn.title, tr('forkRunUnsupportedAntigravityTurn'));

    let forkNativeCalls = 0;
    const forkController = SessionForkController.create({
      getState: () => ({
        providerId: 'antigravity',
        activeSessionId: 's1',
        sessions: [{
          id: 's1',
          providerId: 'antigravity',
          codexThreadId: 'agy:sess-1',
          runs: [{ id: 'run-1', status: 'completed', providerId: 'antigravity', codexThreadId: 'agy:sess-1', codexTurnId: 'turn-1' }]
        }]
      }),
      sendBackgroundNative: async () => { forkNativeCalls += 1; return { ok: true }; },
      showPluginToast: () => {},
      tr
    });
    await assert.rejects(
      () => forkController.forkRunFromNode('run-1'),
      { code: 'antigravity_unsupported_operation' }
    );
    assert.equal(forkNativeCalls, 0);

    // 3. Local skills & parallel-subagents are disabled with explicit hints under Antigravity.
    const skillsPanel = doc.createElement('div');
    const overleafToggle = doc.createElement('input'); overleafToggle.dataset.loadCodexOverleafSkills = '';
    const overleafList = doc.createElement('div'); overleafList.dataset.localSkillList = '';
    const localList = doc.createElement('div'); localList.dataset.codexLocalSkillList = '';
    skillsPanel.append(overleafToggle, overleafList, localList);

    const localSkills = LocalSkillsPanel.createLocalSkillsPanelController({
      document: doc,
      getPanel: () => skillsPanel,
      getState: () => ({
        codexOverleafSkills: [
          { id: 'parallel-subagents', title: 'Parallel subagents', removable: false },
          { id: 'annotated-rewrite', title: 'Annotated rewrite', removable: false }
        ]
      }),
      getCodexLocalSkills: () => [{ id: 'local-1', title: 'My local skill', enabled: true }],
      isAntigravityActive: () => true,
      tr,
      tx: en => en
    });
    localSkills.renderLocalSkillList();

    assert.equal(overleafToggle.disabled, true);
    assert.ok(overleafList.querySelector('[data-antigravity-skills-notice="true"]'));
    assert.ok(localList.querySelector('[data-antigravity-skills-notice="true"]'));
    const parallelRow = overleafList.querySelector('[data-skill-id="parallel-subagents"]');
    assert.ok(parallelRow);
    assert.equal(parallelRow.dataset.disabled, 'true');
    assert.ok(parallelRow.querySelector('[data-skill-unavailable-hint="parallel-subagents"]'));
    assert.equal(parallelRow.querySelector('input').disabled, true);
    assert.equal(localList.querySelector('input').disabled, true);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Antigravity failure codes, ENOENT handling, declined tool items, and compatibility gate behave as contracted', async () => {
  const explicitCodes = [
    'antigravity_not_found',
    'antigravity_auth_required',
    'antigravity_unsupported_operation',
    'antigravity_login_timeout',
    'antigravity_login_failed',
    'antigravity_status_failed',
    'antigravity_models_unavailable',
    'antigravity_mode_unavailable',
    'antigravity_rate_limited',
    'antigravity_runtime_error'
  ];

  for (const code of explicitCodes) {
    assert.ok(FailureReasons.FAILURE_CODE_CATALOG[code], `catalog entry missing for ${code}`);
    const normalized = FailureReasons.normalizeFailureReason({ code });
    assert.equal(normalized.code, code);
    assert.equal(FailureReasons.validateFailureReason(normalized).ok, true);

    const displays = {};
    for (const locale of ['en', 'zh']) {
      const lookup = key => {
        const value = I18n.t(locale, key);
        return value !== key ? value : undefined;
      };
      const display = FailureReasons.formatFailureReasonForDisplay(normalized, locale, lookup);
      assert.ok(display.userMessage.length > 0);
      assert.ok(display.nextAction.length > 0);
      assert.ok(I18n.MESSAGES[locale][`runOutcomeCause_${code}`]);
      displays[locale] = display;

      const translated = AgentTranscript.translateRawError('Raw error', { code, locale });
      assert.equal(translated.failureCode, code);
      assert.ok(translated.conclusion.length > 0);
      assert.ok(translated.nextStep.length > 0);
    }
    assert.notEqual(displays.en.userMessage, displays.zh.userMessage);
    assert.notEqual(displays.en.nextAction, displays.zh.nextAction);
  }

  // Generic fallback for unknown antigravity_* and ACP_* codes (and no bracketed English code leak in zh).
  const coordWin = loadBrowserModule('extension/src/content/providerSettingsCoordinator.js', {
    document: createFakeDocument()
  });
  let zhErrorText = '';
  const zhCoord = coordWin.CodexOverleafProviderSettingsCoordinator.create({
    document: createFakeDocument(),
    ProviderProfiles,
    tx: (_en, zh) => zh,
    hasAntigravityRuntime: () => true,
    ProviderSettingsDialog: {
      create: () => ({
        open() {}, close() { return true; }, setCatalog() {}, offerCatalog() { return true; },
        setBusy(_k, msg) { if (msg) zhErrorText = msg; }, setStatus() {},
        setAntigravityStatus(next) { if (next.error) zhErrorText = next.error; },
        isOpen: () => true, destroy() {}, _instance: { selectedId: 'antigravity' }
      })
    },
    sendBackgroundNative: async ({ method }) => method === 'codex.providers.antigravity.status'
      ? { ok: false, error: { code: 'ACP_STREAM_CLOSED', message: '[ACP_STREAM_CLOSED] unexpected EOF' } }
      : { ok: true, result: { providers: [{ id: 'builtin', kind: 'builtin' }, { id: 'antigravity', kind: 'antigravity' }] } }
  });
  await zhCoord.refreshAntigravityStatus().catch(() => {});
  assert.ok(zhErrorText.length > 0);
  assert.equal(/\[ACP_|\[antigravity_/i.test(zhErrorText), false);

  for (const unknownCode of ['antigravity_custom_failure', 'ACP_INTERNAL_ERROR']) {
    const normalized = FailureReasons.normalizeFailureReason({ code: unknownCode });
    assert.equal(normalized.code, 'antigravity_runtime_error');
    const zhTranslated = AgentTranscript.translateRawError(`[${unknownCode}] raw`, { code: unknownCode, locale: 'zh' });
    assert.equal(zhTranslated.failureCode, 'antigravity_runtime_error');
    assert.equal(/\[ACP_|\[antigravity_/i.test(zhTranslated.conclusion), false);
  }

  // ENOENT must never trigger codex_not_found for Antigravity runs.
  const agySpawnEnoent = AgentTranscript.translateRawError('spawn agy ENOENT', { providerId: 'antigravity', locale: 'en' });
  assert.equal(agySpawnEnoent.failureCode, 'antigravity_not_found');
  const agyThreadEnoent = AgentTranscript.translateRawError('ENOENT: no such file', { threadId: 'agy:sess-1', locale: 'en' });
  assert.notEqual(agyThreadEnoent.failureCode, 'codex_not_found');
  const agyCodeEnoent = AgentTranscript.translateRawError('ENOENT: missing dir', { code: 'antigravity_status_failed', locale: 'en' });
  assert.equal(agyCodeEnoent.failureCode, 'antigravity_status_failed');
  const codexEnoent = AgentTranscript.translateRawError('spawn codex ENOENT', { providerId: 'builtin', locale: 'en' });
  assert.equal(codexEnoent.failureCode, 'codex_not_found');

  // Declined fileChange and commandExecution items render as blocked/skipped, never completed.
  const declinedFileEvent = {
    type: 'codex.session.event',
    detail: {
      method: 'item/completed',
      params: { threadId: 'agy:s1', turnId: 't1', item: { id: 'fc1', type: 'fileChange', status: 'declined', changes: [{ path: 'main.tex', kind: 'update' }] } }
    }
  };
  const completedFileEvent = {
    type: 'codex.session.event',
    detail: {
      method: 'item/completed',
      params: { threadId: 'agy:s1', turnId: 't1', item: { id: 'fc2', type: 'fileChange', status: 'completed', changes: [{ path: 'main.tex', kind: 'update' }] } }
    }
  };
  for (const locale of ['en', 'zh']) {
    const declinedMapped = AgentTranscript.mapAgentEventToActivity(declinedFileEvent, { locale });
    const completedMapped = AgentTranscript.mapAgentEventToActivity(completedFileEvent, { locale });
    assert.equal(declinedMapped.status, 'blocked');
    assert.notEqual(declinedMapped.title, completedMapped.title);
    assert.equal(RunActivityModel.capture(declinedMapped).state, 'skipped');
  }
  const declinedCmdEvent = {
    type: 'codex.session.event',
    detail: {
      method: 'item/completed',
      params: { threadId: 'agy:s1', turnId: 't1', item: { id: 'cmd1', type: 'commandExecution', status: 'declined', command: 'rm -rf .' } }
    }
  };
  const completedCmdEvent = {
    type: 'codex.session.event',
    detail: {
      method: 'item/completed',
      params: { threadId: 'agy:s1', turnId: 't1', item: { id: 'cmd2', type: 'commandExecution', status: 'completed', command: 'ls' } }
    }
  };
  for (const locale of ['en', 'zh']) {
    const declinedMapped = AgentTranscript.mapAgentEventToActivity(declinedCmdEvent, { locale });
    const completedMapped = AgentTranscript.mapAgentEventToActivity(completedCmdEvent, { locale });
    assert.equal(declinedMapped.status, 'blocked');
    assert.notEqual(declinedMapped.title, completedMapped.title);
    assert.equal(RunActivityModel.capture(declinedMapped).state, 'skipped');
  }

  // Compatibility: missing Codex CLI stays native_unhealthy even when agy is ok.
  const allCaps = Object.fromEntries(Compatibility.REQUIRED_CAPABILITIES.map(cap => [cap, true]));
  const evalResult = Compatibility.evaluateNativeCompatibility({
    ok: true,
    result: {
      version: Compatibility.BUILD_TARGET_VERSION,
      protocolVersion: Compatibility.EXTENSION_PROTOCOL_VERSION,
      capabilities: { ...allCaps, antigravityRuntime: true },
      environment: { codex: { ok: false }, antigravity: { ok: true } }
    }
  }, { version: Compatibility.BUILD_TARGET_VERSION });
  assert.equal(evalResult.status, 'native_unhealthy');
  assert.equal(evalResult.classification, 'incompatible');

  for (const type of ['antigravity.thread.fresh', 'codex.thread.fresh']) {
    const en = AgentTranscript.mapAgentEventToActivity({ type }, { locale: 'en' });
    const zh = AgentTranscript.mapAgentEventToActivity({ type }, { locale: 'zh' });
    assert.equal(en.visible, true);
    assert.equal(en.status, 'warning');
    assert.notEqual(en.title, zh.title);
  }
});

test('ProviderSettingsDialog renders Antigravity capability gate and detail states without edit or delete controls', () => {
  const doc = createFakeDocument();
  doc.documentElement = doc.createElement('html');
  doc.querySelector = () => null;
  let hasCapability = false;
  let currentProjectProvider = 'builtin';
  let loginClicked = 0;
  let refreshClicked = 0;
  let activateClicked = 0;

  // Give dialog root real child containers for list/detail/footer so render() populates them.
  const dialogWin = loadBrowserModule('extension/src/content/providerSettingsDialog.js', { document: doc });
  const dialog = dialogWin.CodexOverleafProviderSettingsDialog.create({
    document: doc,
    ProviderProfiles,
    tx: en => en,
    callbacks: {
      hasCurrentProject: () => true,
      hasAntigravityRuntime: () => hasCapability,
      getCurrentProjectProviderId: () => currentProjectProvider,
      onAntigravityLogin: () => { loginClicked += 1; },
      onAntigravityRefresh: () => { refreshClicked += 1; },
      onActivateAntigravity: () => { activateClicked += 1; }
    }
  });
  // Attach structural slots matching ensureRoot's template on the FakeElement root.
  const root = dialog._instance.root;
  const titleEl = doc.createElement('h2'); titleEl.dataset.providerDialogTitle = '';
  const expEl = doc.createElement('span'); expEl.dataset.providerDialogExperimental = '';
  const subEl = doc.createElement('p'); subEl.dataset.providerDialogSubtitle = '';
  const listEl = doc.createElement('aside'); listEl.dataset.providerList = '';
  const detailEl = doc.createElement('main'); detailEl.dataset.providerDetail = '';
  const statusEl = doc.createElement('div'); statusEl.dataset.providerStatus = '';
  const footerEl = doc.createElement('div'); footerEl.dataset.providerFooterActions = '';
  root.replaceChildren(titleEl, expEl, subEl, listEl, detailEl, statusEl, footerEl);

  // Without antigravityRuntime capability, Antigravity is shown as disabled/unavailable and cannot be selected.
  dialog.open({ providers: [{ id: 'builtin', kind: 'builtin' }] });
  assert.ok(listEl.innerHTML.includes('data-provider-unavailable="antigravity"'));
  assert.equal(listEl.innerHTML.includes('data-provider-row="antigravity"'), false);

  // With antigravityRuntime capability, Antigravity is selectable and shows status states.
  hasCapability = true;
  dialog.setCatalog({
    activeProviderId: 'builtin',
    providers: [
      { id: 'builtin', kind: 'builtin' },
      { id: 'antigravity', kind: 'antigravity', revision: 0, name: 'Antigravity', editable: false, deletable: false, models: [] }
    ]
  }, 'antigravity');
  assert.ok(listEl.innerHTML.includes('data-provider-row="antigravity"'));
  assert.equal(footerEl.innerHTML.includes('data-provider-action="delete"'), false);
  assert.equal(footerEl.innerHTML.includes('data-provider-action="save"'), false);

  // Not installed -> login and activate disabled.
  dialog.setAntigravityStatus({ loading: false, loaded: true, status: { installed: false, signedIn: false, tier: null, error: null } });
  assert.ok(detailEl.innerHTML.includes('data-tone="failed"'));
  assert.ok(detailEl.innerHTML.includes('data-provider-action="antigravity-login" disabled'));
  assert.ok(detailEl.innerHTML.includes('data-provider-action="activate-antigravity" disabled'));

  // Signed out -> login enabled, activate disabled.
  dialog.setAntigravityStatus({ loading: false, loaded: true, status: { installed: true, version: '1.5.18', signedIn: false, tier: null, error: null } });
  assert.ok(detailEl.innerHTML.includes('data-tone="warning"'));
  assert.equal(detailEl.innerHTML.includes('data-provider-action="antigravity-login" disabled'), false);
  assert.ok(detailEl.innerHTML.includes('data-provider-action="activate-antigravity" disabled'));

  // Signed in with tier -> tier rendered, activate enabled.
  dialog.setAntigravityStatus({ loading: false, loaded: true, status: { installed: true, version: '1.5.18', signedIn: true, tier: { name: 'Google AI Ultra', id: 'ultra' }, error: null } });
  assert.ok(detailEl.innerHTML.includes('Google AI Ultra'));
  assert.equal(detailEl.innerHTML.includes('data-provider-action="activate-antigravity" disabled'), false);
  assert.equal(loginClicked + refreshClicked + activateClicked, 0);
  dialog.destroy();
});

test('AgentBrand protects product and Codex-only phrases while twin-form panel and run brands stay isolated', async () => {
  // 1. brandIdForProvider, brandText protections, and iconUrl inline data URLs.
  assert.equal(AgentBrand.brandIdForProvider('antigravity'), 'antigravity');
  assert.equal(AgentBrand.brandIdForProvider('builtin'), 'codex');
  assert.equal(AgentBrand.brandIdForProvider('custom-1'), 'codex');
  assert.equal(AgentBrand.brandIdForProvider(''), 'codex');

  assert.equal(AgentBrand.brandText('Ask Codex anything.', 'antigravity'), 'Ask Antigravity anything.');
  assert.equal(AgentBrand.brandText('问 Codex 任何事。', 'antigravity'), '问 Antigravity 任何事。');
  assert.equal(AgentBrand.brandText('Ask Codex anything.', 'codex'), 'Ask Codex anything.');
  for (const phrase of [
    'Codex Overleaf Link',
    'Built-in Codex',
    'Codex CLI',
    'Codex Overleaf skills',
    'Local Codex skills',
    'Codex 本地技能'
  ]) {
    assert.equal(AgentBrand.brandText(`Keep ${phrase} and ask Codex.`, 'antigravity'), `Keep ${phrase} and ask Antigravity.`);
  }
  assert.ok(AgentBrand.iconUrl('antigravity', 'empty').startsWith('data:image/png;base64,'));
  assert.ok(AgentBrand.iconUrl('antigravity', 'dialog').startsWith('data:image/png;base64,'));
  assert.equal(AgentBrand.iconUrl('codex', 'empty', p => `chrome-extension://ext/${p}`), 'chrome-extension://ext/assets/icons/codex-overleaf-icon.png');
  assert.equal(AgentBrand.iconUrl('codex', 'dialog', p => `chrome-extension://ext/${p}`), 'chrome-extension://ext/assets/icons/codex-overleaf-dialog-icon.png');

  // 2. Run brand resolution follows snapshot providerId, then providerId, then agy: threadId fallback.
  assert.equal(AgentTranscript.brandIdForRun({ executionSnapshot: { providerId: 'builtin' }, codexThreadId: 'agy:legacy' }), 'codex');
  assert.equal(AgentTranscript.brandIdForRun({ executionSnapshot: { providerId: 'antigravity' } }), 'antigravity');
  assert.equal(AgentTranscript.brandIdForRun({ codexThreadId: 'agy:sess-42' }), 'antigravity');
  assert.equal(AgentTranscript.brandIdForRun({ codexThreadId: 'thr_123' }), 'codex');

  // 3. While Antigravity is active on the panel, empty state + placeholder read Antigravity,
  //    while a past Codex run keeps Codex across activity, presence, completion meta, and failure notices
  //    and model answers / filenames mentioning Codex are never rewritten.
  const doc = createFakeDocument();
  const prevDoc = globalThis.document;
  const prevWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = { sessionStorage: { getItem: () => null, setItem() {} } };
  try {
    let activeProviderId = 'antigravity';
    const panelBrand = () => AgentBrand.brandIdForProvider(activeProviderId);
    const panelTr = (key, params) => AgentBrand.brandText(I18n.t('en', key, params), panelBrand());
    const panelTx = en => AgentBrand.brandText(en, panelBrand());

    assert.match(panelTr('placeholder'), /Antigravity/);
    assert.doesNotMatch(panelTr('placeholder'), /\bCodex\b/);

    const presence = RunPresence.create({ tx: en => en, getLocale: () => 'en', document: doc, random: () => 0.4 });
    const emptyEl = doc.createElement('div');
    const emptyTitle = doc.createElement('div');
    emptyTitle.className = 'empty-runs-title';
    emptyEl.append(emptyTitle);
    presence.decorateEmpty(emptyEl, { projectName: 'Paper', brand: panelBrand() });
    const emptyMarkHtml = emptyEl.children[0].innerHTML;
    assert.ok(emptyMarkHtml.includes('data-brand="antigravity"'));
    assert.ok(emptyMarkHtml.includes('--mark-leaf-origin:66.8% 41.5%;--mark-cloud-origin:44.6% 56.4%'));
    const tipText = emptyEl.querySelector('.run-empty-tip-text').textContent;
    assert.match(tipText, /Antigravity/);

    const runningCodexHeader = doc.createElement('span');
    presence.paintRunning(runningCodexHeader, { runId: 'r-codex', brand: 'codex', label: { kind: 'stage', text: 'Started Codex' } });
    assert.ok(runningCodexHeader.innerHTML.includes('data-brand="codex"'));
    assert.ok(runningCodexHeader.innerHTML.includes('--mark-leaf-origin:70.6% 41.6%;--mark-cloud-origin:44.3% 55'));

    // Activity titles follow each run's own brand and never rewrite filenames or model text.
    const fileEvent = {
      type: 'codex.session.event',
      detail: { method: 'item/completed', params: { item: { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'CodexNotes.tex', kind: 'update' }] } } }
    };
    const codexActivity = AgentTranscript.mapAgentEventToActivity(fileEvent, { locale: 'en', providerId: 'builtin' });
    const agyActivity = AgentTranscript.mapAgentEventToActivity(fileEvent, { locale: 'en', providerId: 'antigravity' });
    assert.equal(codexActivity.title, 'Codex edited local files: CodexNotes.tex.');
    assert.equal(agyActivity.title, 'Antigravity edited local files: CodexNotes.tex.');

    const modelMsgEvent = {
      type: 'codex.session.event',
      detail: { method: 'item/completed', params: { threadId: 'agy:s1', item: { id: 'm1', type: 'agentMessage', text: 'Codex is mentioned in my answer.' } } }
    };
    const mappedAnswer = AgentTranscript.mapAgentEventToActivity(modelMsgEvent, { locale: 'en', providerId: 'antigravity' });
    assert.equal(mappedAnswer.title, 'Codex is mentioned in my answer.');

    // Setup step in RunActivitySummary follows the run's brand even when panel is switched.
    const summaryWin = loadBrowserModule('extension/src/content/runActivitySummary.js', {
      document: doc,
      window: { sessionStorage: { getItem: () => null, setItem() {} } },
      CodexOverleafAgentBrand: AgentBrand
    });
    const makeCardHost = runId => {
      const root = doc.createElement('section');
      root.dataset.runId = runId;
      const process = doc.createElement('details'); process.dataset.runProcess = '';
      const summary = doc.createElement('summary'); summary.dataset.runProcessSummary = '';
      const status = doc.createElement('span'); status.dataset.runStatus = '';
      summary.append(status);
      process.append(summary);
      const events = doc.createElement('div'); events.dataset.runEvents = '';
      const guidance = doc.createElement('div'); guidance.dataset.runGuidance = '';
      const report = doc.createElement('div'); report.dataset.runReport = '';
      root.append(guidance, process, events, report);
      return root;
    };
    const codexRun = {
      id: 'run-codex-1', status: 'completed', executionSnapshot: { providerId: 'builtin' },
      events: [{ kind: 'activity', status: 'completed', title: 'Local Codex session is starting.', timestamp: '2026-11-28T00:00:00Z' }]
    };
    const agyRun = {
      id: 'run-agy-1', status: 'completed', executionSnapshot: { providerId: 'antigravity' },
      events: [{ kind: 'activity', status: 'completed', title: 'Local Antigravity session is starting.', timestamp: '2026-11-28T00:00:00Z' }]
    };
    const summaryCtrl = summaryWin.CodexOverleafRunActivitySummary.create({
      RunActivityModel, AgentBrand, tx: panelTx, rawTx: en => en,
      findRunRecord: id => (id === codexRun.id ? codexRun : agyRun),
      getPanel: () => doc.createElement('div'), cssEscape: s => s,
      formatElapsed: () => '1s', renderMarkdownBlockText() {}, renderRunEvent: () => doc.createElement('div'),
      presence, classifyStatus: () => 'done'
    });
    const codexCard = makeCardHost(codexRun.id);
    const agyCard = makeCardHost(agyRun.id);
    summaryCtrl.mount(codexCard, codexRun);
    summaryCtrl.mount(agyCard, agyRun);
    assert.equal(codexCard.querySelector('.run-setup-label').textContent, 'Started Codex');
    assert.equal(agyCard.querySelector('.run-setup-label').textContent, 'Started Antigravity');

    // RunCompletionMeta and RunFailureNotice preserve each run's own brand regardless of panel provider.
    const metaInput = [{ key: 'nextStep', label: 'Next', value: 'Continue the conversation, or switch to Auto to let Codex edit files.' }];
    const codexMeta = RunCompletionMeta.projectCompletionMeta(metaInput, codexRun, {
      tx: panelTx, tr: panelTr, getLocale: () => 'en', isTrackedChangeLifecycleRun: () => false
    });
    const agyMeta = RunCompletionMeta.projectCompletionMeta(metaInput, agyRun, {
      tx: panelTx, tr: panelTr, getLocale: () => 'en', isTrackedChangeLifecycleRun: () => false
    });
    assert.match(codexMeta[0].value, /\bCodex\b/);
    assert.match(agyMeta[0].value, /\bAntigravity\b/);

    const noticeCtrl = RunFailureNotice.create({ tr: panelTr, I18n, getLocale: () => 'en', document: doc });
    const codexReportEl = doc.createElement('section'); codexReportEl.dataset.status = 'failed';
    const agyReportEl = doc.createElement('section'); agyReportEl.dataset.status = 'failed';
    const failureEvent = { failure: { code: 'codex_result_parse_failed', stage: 'codex' } };
    noticeCtrl.append(codexReportEl, failureEvent, codexRun);
    noticeCtrl.append(agyReportEl, failureEvent, agyRun);
    assert.match(codexReportEl.querySelector('p').textContent, /\bCodex\b/);
    assert.doesNotMatch(codexReportEl.querySelector('p').textContent, /\bAntigravity\b/);
    assert.match(agyReportEl.querySelector('p').textContent, /\bAntigravity\b/);

    // Composite writeback conclusion keeps the model prefix verbatim while branding the product suffix.
    const modelPrefix = 'Codex appears in the model answer.';
    const compositeRaw = `${modelPrefix}\n\nSync note: local Codex changes were sent to Overleaf, but some items were skipped.`;
    const projectedComposite = RunCompletionMeta.projectCompletionConclusion({
      kind: 'report',
      detailStructured: {
        conclusion: compositeRaw,
        conclusionSource: { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: modelPrefix.length }
      }
    }, agyRun, 'en');
    assert.ok(projectedComposite.startsWith(modelPrefix));
    assert.match(projectedComposite.slice(modelPrefix.length), /Antigravity/);

    // RunTimelineView empty state icon falls back to AgentBrand.iconUrl(panelBrand, 'empty') when presence is absent.
    const timelinePanel = doc.createElement('div');
    const logEl = doc.createElement('div'); logEl.dataset.log = '';
    timelinePanel.append(logEl);
    const timeline = RunTimelineView.create({
      I18n, FailureReasons, RunResultActions: RunResultActions.create({ tr: panelTr, document: doc }),
      tr: panelTr, tx: panelTx, rawTr: key => I18n.t('en', key), rawTx: en => en,
      getPanelBrandId: panelBrand, getLocale: () => 'en',
      getPanel: () => timelinePanel, getState: () => ({ providerId: activeProviderId, runs: [] }),
      formatElapsed: () => '0s', cssEscape: s => s, sanitizeAssistantVisibleText: v => String(v || ''),
      sanitizeAssistantVisibleValue: v => v
    });
    timeline.renderRunHistory();
    assert.ok(logEl.querySelector('.codex-empty-icon').src.startsWith('data:image/png;base64,'));
    assert.match(logEl.querySelector('.empty-runs-title').textContent, /Antigravity/);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWindow;
  }

  // 4. Background codex-overleaf/agent-brand enforces sender admission and updates/resets toolbar icon+title.
  let onMessageListener = null;
  const iconCalls = [];
  const titleCalls = [];
  const bgContext = {
    URL, console, setTimeout, clearTimeout,
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ close() {} }),
    OffscreenCanvas: class {
      constructor(w, h) { this.w = w; this.h = h; }
      getContext() { return { drawImage() {}, getImageData: (_x, _y, w, h) => ({ width: w, height: h }) }; }
    },
    chrome: {
      runtime: {
        id: 'ext-1',
        getURL: p => `chrome-extension://ext-1/${p}`,
        getManifest: () => ({
          background: { service_worker: 'src/background.js' },
          action: { default_title: 'Codex Overleaf Link', default_icon: { 16: 'assets/icons/icon16.png', 32: 'assets/icons/icon32.png' } }
        }),
        onMessage: { addListener: fn => { onMessageListener = fn; } },
        onConnect: { addListener() {} }
      },
      action: {
        setIcon: async payload => { iconCalls.push(payload); },
        setTitle: async payload => { titleCalls.push(payload); }
      },
      storage: { session: { get: async () => ({}), set: async () => {} } }
    },
    CodexOverleafAgentBrand: AgentBrand,
    CodexOverleafCompatibility: {}, CodexOverleafManagedUpdateProjection: {}, CodexOverleafNativeRequestIdentity: {},
    CodexOverleafGlobalPreferences: { installBackground() {} }, CodexOverleafStorageRunActions: {},
    CodexOverleafSharedSessionTransfer: {}, CodexOverleafSharedSessionsBackground: { installBackground() {} },
    CodexOverleafUpdateRuntimeIdentity: {}, CodexOverleafBootstrapMigration: {},
    CodexOverleafBackgroundUpdateSafety: { create: () => ({}) },
    CodexOverleafUpdateConsent: {}, CodexOverleafUpdateRevocation: {}, CodexOverleafUpdateCoordinator: { init() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8'), bgContext);
  const sendBrand = (brand, sender) => new Promise(resolve => onMessageListener({ type: 'codex-overleaf/agent-brand', brand }, sender, resolve));

  // Rejected senders: wrong extension id, non-Overleaf origin, non-/project path, subframe.
  assert.equal((await sendBrand('antigravity', { id: 'other', tab: { id: 7, url: 'https://www.overleaf.com/project/p1' }, url: 'https://www.overleaf.com/project/p1', frameId: 0 })).ok, false);
  assert.equal((await sendBrand('antigravity', { id: 'ext-1', tab: { id: 7, url: 'https://example.com/project/p1' }, url: 'https://example.com/project/p1', frameId: 0 })).ok, false);
  assert.equal((await sendBrand('antigravity', { id: 'ext-1', tab: { id: 7, url: 'https://www.overleaf.com/learn' }, url: 'https://www.overleaf.com/learn', frameId: 0 })).ok, false);
  assert.equal((await sendBrand('antigravity', { id: 'ext-1', tab: { id: 7, url: 'https://www.overleaf.com/project/p1' }, url: 'https://www.overleaf.com/project/p1', frameId: 2 })).ok, false);
  assert.equal(iconCalls.length, 0);

  // Accepted Overleaf project sender switches to Antigravity and back to Codex default.
  const allowedSender = { id: 'ext-1', tab: { id: 9, url: 'https://www.overleaf.com/project/p1' }, url: 'https://www.overleaf.com/project/p1', frameId: 0 };
  assert.deepEqual({ ...(await sendBrand('antigravity', allowedSender)) }, { ok: true, brand: 'antigravity' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(iconCalls.length, 1);
  assert.equal(iconCalls[0].tabId, 9);
  assert.ok(iconCalls[0].imageData[16] && iconCalls[0].imageData[32]);
  assert.equal(titleCalls.at(-1).title, 'Codex Overleaf Link · Antigravity');

  assert.deepEqual({ ...(await sendBrand('codex', allowedSender)) }, { ok: true, brand: 'codex' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(iconCalls.length, 2);
  assert.equal(iconCalls[1].tabId, 9);
  assert.equal(iconCalls[1].path[16], '/assets/icons/icon16.png');
  assert.equal(titleCalls.at(-1).title, 'Codex Overleaf Link');
});
