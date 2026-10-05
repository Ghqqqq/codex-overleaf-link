'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./extractFunction');
const Profiles = require('../../extension/src/shared/providerProfiles');
const Support = require('../../extension/src/content/modelPickerSupport');
const Store = require('../../native-host/src/providerStore');
const Runtime = require('../../native-host/src/providerRuntime');
const source = name => fs.readFileSync(path.join(__dirname, '../../extension/src/content', name + '.js'), 'utf8');
function moduleApi(name, apiName, extra = {}) {
  const context = { window: {}, ...extra };
  vm.runInNewContext(source(name), context, { filename: name + '.js' });
  return context.window[apiName];
}
function select() {
  return { options: [], dataset: {}, disabled: false, _value: '',
    get value() { return this._value; }, set value(v) { this._value = this.options.some(o => o.value === v) ? v : ''; },
    get textContent() { return ''; }, set textContent(_) { this.options = []; this._value = ''; },
    append(o) { this.options.push(o); if (this.options.length === 1) this._value = o.value; } };
}
function modelPicker(state, send) {
  const currentState = () => typeof state === 'function' ? state() : state;
  const controls = { '[data-model]': select(), '[data-reasoning]': select(), '[data-speed]': select() };
  const panel = { querySelector: s => controls[s] || null, querySelectorAll: () => [] };
  const api = moduleApi('modelPicker', 'CodexOverleafModelPicker', {
    document: { createElement: () => ({ dataset: {}, value: '', textContent: '' }) }
  }).create({ Support, getState: currentState, getPanel: () => panel, tr: k => k, tx: en => en, getLocale: () => 'en',
    getProviderSelection: () => ({ providerId: currentState().providerId, providerRevision: currentState().providerRevision }),
    getRenderedModelEntries: () => Support.getRenderedModelEntries(panel), readSelectedSpeedInput: () => controls['[data-speed]'].value,
    sendBackgroundNative: send, persistPanelInputs: async () => {} });
  const initial = currentState();
  api.renderModelOptions([{ id: initial.model, label: initial.model, reasoningEfforts: [], speedTiers: ['standard'] }], initial.model);
  return { api, controls, panel };
}
function draft(name) {
  return { name, baseUrl: `https://${name}.example.invalid/v1`, wireApiPreference: 'responses',
    models: [{ id: name + '-model', label: name + '-model' }], defaultModelId: name + '-model' };
}
async function providerHarness(t, { running = false, locale = 'en' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, 'codex'), CODEX_OVERLEAF_PROVIDER_STORE_DIR: path.join(dir, 'store') };
  const profiles = {};
  for (const name of ['alpha', 'beta']) {
    const value = draft(name);
    const result = Store.upsertProvider({ draft: value, secretMutation: { kind: 'replace', value: 'SYNTHETIC_UI_KEY' },
      activate: name === 'alpha', disclosureHost: name + '.example.invalid', disclosureBaseUrl: value.baseUrl }, env);
    profiles[name] = result.providers.find(p => p.id === result.savedProviderId);
  }
  let state = { providerId: profiles.alpha.id, providerRevision: profiles.alpha.revision, model: 'alpha-model',
    reasoningEffort: 'none', speedTier: 'standard', sessions: [{ id: 'session-a', codexThreadId: 'original-thread', runs: [], pendingInputs: [] }] };
  let active = running, confirm = true, callbackPromise, beforeRequest, beforeModels;
  const calls = [], statuses = [], busy = [], toasts = [], confirmations = [];
  const tx = (en, zh) => locale === 'zh' ? zh : en;
  const send = async request => {
    calls.push(request);
    await beforeRequest?.(request);
    if (request.method === 'codex.models') {
      await beforeModels?.(request);
      try { return { ok: true, result: Runtime.resolveProviderModels(request.params, env,
        () => ({ models: [{ id: 'builtin-model', label: 'Built-in model' }], source: 'fixture' })) }; }
      catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
    }
    if (request.method === 'codex.providers.test') throw new Error('Real model calls are forbidden by this harness.');
    return Runtime.handleProviderRequest({ id: 'provider-ui', ...request }, env);
  };
  let coordinator;
  const picker = modelPicker(() => state, send);
  const selection = moduleApi('projectProviderSelection', 'CodexOverleafProjectProviderSelection').create({
    tx, tr: k => k, getRunningSessionIds: () => active ? ['session-a'] : [], showToast: (...a) => toasts.push(a),
    showConfirm: async options => { confirmations.push(options); return typeof confirm === 'function' ? confirm() : confirm; },
    getState: () => state, setState: next => { state = next; }, normalizeState: v => v,
    getRunSelection: id => coordinator.getRunSelection(id), getPanel: () => picker.panel,
    readSelectedModel: () => picker.controls['[data-model]'].value, readSelectedSpeed: () => 'standard', applyStateToPanel() {} });
  let callbacks;
  const dialog = { isOpen: () => true, setCatalog() {}, setBusy: (state, message) => busy.push({ state, message }),
    setStatus: value => statuses.push(value), destroy() {} };
  const fakeWindow = { BroadcastChannel: class { addEventListener() {} postMessage() {} close() {} } };
  coordinator = moduleApi('providerSettingsCoordinator', 'CodexOverleafProviderSettingsCoordinator').create({
    ProviderProfiles: Profiles, ProviderSettingsDialog: { create: options => { callbacks = options.callbacks; return dialog; } },
    document: {}, window: fakeWindow, tx, getSelectedProviderId: () => state.providerId, getSelectedProviderRevision: () => state.providerRevision, getSelectedModel: () => state.model,
    setSelectedProviderId: selection.commit, confirmProviderSwitch: selection.confirmSwitch,
    assertProviderSwitchAllowed: selection.assertSwitchAllowed, refreshModelOptions: picker.api.loadModelOptions,
    sendBackgroundNative: send, persistInputs: async () => {} });
  await coordinator.ensureLoaded();
  const handleClick = Function('readContext', 'validateConnectionForm', 'canActivateCurrentProvider', 'confirmProviderAction',
    extractFunction(source('providerSettingsDialog'), 'handleClick') + '; return handleClick;')(
    instance => instance.context, () => true, () => true, async () => true);
  async function click(action, context) {
    const wrapped = Object.fromEntries(Object.entries(callbacks).map(([name, cb]) => [name, (...args) => {
      callbackPromise = Promise.resolve(cb(...args)); return callbackPromise;
    }]));
    const node = { dataset: { providerAction: action }, closest: s => s === '[data-provider-action]' ? node : null };
    callbackPromise = null;
    await handleClick({ context, tx, callbacks: wrapped, root: { querySelector: () => ({ checked: true }) } },
      { target: node, preventDefault() {} });
    await callbackPromise;
  }
  const context = (name, changes = {}) => {
    const p = Store.listProviders(env).providers.find(p => p.id === profiles[name].id);
    return { profileId: p.id, expectedRevision: p.revision, draft: { ...p, ...changes }, secretMutation: { kind: 'unchanged' },
      disclosureHost: new URL(changes.baseUrl || p.baseUrl).host, disclosureBaseUrl: changes.baseUrl || p.baseUrl };
  };
  return { env, profiles, calls, statuses, busy, toasts, confirmations, coordinator, selection, picker, click, context,
    state: () => state, running: v => { active = v; }, confirm: v => { confirm = v; },
    beforeRequest: fn => { beforeRequest = fn; }, beforeModels: fn => { beforeModels = fn; }, callbacks };
}
module.exports = { providerHarness, modelPicker, source, Store, Runtime, extractFunction };
