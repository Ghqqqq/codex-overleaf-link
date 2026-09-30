const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ChangeHistoryModel = require('../extension/src/shared/changeHistoryModel');

const settingsModuleSources = [
  'moduleRegistryKernel.js', 'settingsWorkbench.js', 'settingsPanel.js', 'changeHistoryView.js'
].map(file => {
  const filename = path.join(__dirname, '../extension/src/content', file);
  return { filename, source: fs.readFileSync(filename, 'utf8') };
});
const maintenanceSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/panelMaintenance.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function element(attributes = {}) {
  const listeners = new Map();
  return {
    textContent: 'Calculating usage...', dataset: {}, open: false,
    getAttribute: key => Object.hasOwn(attributes, key) ? attributes[key] : null,
    removeAttribute: key => { delete attributes[key]; },
    setAttribute: (key, value) => { attributes[key] = String(value); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    emit(type) { for (const handler of listeners.get(type) || []) handler({ target: this }); },
    closest: () => null
  };
}

function fixture(estimate) {
  let locale = 'en';
  let projectId = 'project-a';
  const panel = { dataset: { settingsScope: 'project' } };
  let sequence = 0;
  let estimateCalls = 0;
  let maintenance;
  let current;
  const timers = new Map();
  const sandbox = {
    CodexOverleafChangeHistoryModel: ChangeHistoryModel,
    navigator: { storage: estimate ? { estimate() { estimateCalls++; return estimate(); } } : undefined },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const { source, filename } of settingsModuleSources) {
    vm.runInContext(source, context, { filename });
  }
  assert.equal(context.CodexOverleafModuleRegistry.resolve('SettingsPanel'), context.CodexOverleafSettingsPanel);
  vm.runInContext(maintenanceSource, context);
  function makePanel() {
    const usage = element({ 'data-i18n': 'storageUsageLoading' });
    const card = element();
    card.dataset.setGroup = 'storage';
    const language = element();
    language.value = 'en';
    const title = element(), subtitle = element();
    const nodes = { '[data-storage-usage]': usage, '[data-storage-card]': card, '[data-language-select]': language,
      '[data-settings-title]': title, '[data-settings-subtitle]': subtitle };
    const root = { querySelector: selector => nodes[selector] || null };
    const container = {
      innerHTML: '', closest: () => panel,
      querySelector: selector => selector === '[data-project-settings-panel]' ? root : nodes[selector] || null,
      querySelectorAll: selector => selector === 'details[data-set-group]' ? [card] : []
    };
    const settings = context.window.CodexOverleafSettingsPanel.create({ container, button: element(),
      i18n: { tr: key => `${locale}:${key}` }, callbacks: {
      onStorageOpen: () => maintenance.refreshStorageUsageSummary(),
      onInputChange: event => { locale = event.target.value; }
    } });
    return { settings, container, usage, card, language, title, subtitle };
  }
  current = makePanel();
  maintenance = context.window.CodexOverleafPanelMaintenance.create({
    ChangeHistoryView: context.CodexOverleafModuleRegistry.resolve('ChangeHistoryView'),
    tx: (en, zh) => locale === 'zh' ? zh : en,
    getCurrentProjectId: () => projectId,
    getPanel: () => panel,
    getSettingsPanelInstance: () => current.settings,
    getState: () => ({ activeSessionId: 'session-a', sessions: [{ id: 'session-a' }, { id: 'session-b' }], runs: [{ id: 'run-a' }] })
  });
  return {
    ...current, maintenance, timers, panel,
    estimateCalls: () => estimateCalls,
    setProject: value => { projectId = value; },
    replacePanel: () => { current = makePanel(); return current; },
    expire() {
      for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); }
    }
  };
}

test('real SettingsPanel public handle exposes the container needed by storage statistics', async () => {
  const f = fixture(() => ({ usage: 2048 }));
  assert.equal(f.settings.container, f.container);
  const request = f.maintenance.refreshStorageUsageSummary();
  assert.match(f.usage.textContent, /^2 loaded conversations \u00b7 1 runs in this project(?: \u00b7 |$)/);
  assert.match(f.usage.textContent, /1 runs in this project/);
  assert.equal(f.usage.getAttribute('data-i18n'), null);
  await request;
  assert.match(f.usage.textContent, /Site total ~2 KB/);
  assert.equal(f.estimateCalls(), 1);
  assert.equal(f.timers.size, 0);
});

test('expanding the storage card triggers statistics without clearing history', async () => {
  const f = fixture(() => ({ usage: 0 }));
  f.card.open = true;
  f.card.emit('toggle');
  await settle();
  assert.match(f.usage.textContent, /Site total ~0 KB/);
  assert.equal(f.estimateCalls(), 1);
  f.card.open = false;
  f.card.emit('toggle');
  assert.equal(f.estimateCalls(), 1);
});

test('a never-resolving capacity request displays counts immediately and has a bounded fallback', async () => {
  const f = fixture(() => new Promise(() => {}));
  const request = f.maintenance.refreshStorageUsageSummary();
  assert.match(f.usage.textContent, /^2 loaded conversations \u00b7 1 runs in this project(?: \u00b7 |$)/);
  assert.equal([...f.timers.values()][0].delay, 2000);
  f.expire();
  await request;
  assert.match(f.usage.textContent, /Site storage estimate unavailable/);
  assert.equal(f.timers.size, 0);
});

test('unsupported, rejected, throwing, and invalid estimates preserve usable counts', async () => {
  for (const estimate of [undefined, () => { throw new Error('blocked'); },
    () => Promise.reject(new Error('rejected')), () => ({ usage: null }), () => ({ usage: -1 })]) {
    const f = fixture(estimate);
    await f.maintenance.refreshStorageUsageSummary();
    assert.match(f.usage.textContent, /^2 loaded conversations \u00b7 1 runs in this project(?: \u00b7 |$)/);
    assert.match(f.usage.textContent, /estimate unavailable/);
    assert.equal(f.timers.size, 0);
  }
});

test('an older response cannot overwrite a newer summary', async () => {
  let resolveOld;
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve; }) : { usage: 2048 });
  const old = f.maintenance.refreshStorageUsageSummary();
  await settle();
  await f.maintenance.refreshStorageUsageSummary();
  resolveOld({ usage: 999 * 1024 * 1024 });
  await old;
  assert.match(f.usage.textContent, /Site total ~2 KB/);
});

test('late responses are ignored after a project, settings-container, or scope change', async () => {
  for (const change of ['project', 'container', 'scope']) {
    let resolveOld;
    const f = fixture(() => new Promise(resolve => { resolveOld = resolve; }));
    const request = f.maintenance.refreshStorageUsageSummary();
    const initial = f.usage.textContent;
    await settle();
    if (change === 'project') f.setProject('project-b');
    else if (change === 'container') f.replacePanel();
    else f.panel.dataset.settingsScope = 'account';
    resolveOld({ usage: 999 * 1024 * 1024 });
    await request;
    assert.equal(f.usage.textContent, initial);
  }
});

test('an open storage card refreshes its dynamic summary after a language change', async () => {
  const f = fixture(() => ({ usage: 2048 }));
  f.card.open = true;
  f.language.value = 'zh';
  f.language.emit('change');
  await settle();
  assert.match(f.usage.textContent, /\u672c\u9879\u76ee\u5df2\u52a0\u8f7d 2 \u4e2a\u5bf9\u8bdd \u00b7 1 \u8f6e\u8fd0\u884c/);
  assert.match(f.usage.textContent, /2 KB/);
  assert.equal(f.usage.getAttribute('data-i18n'), null);
});

test('homepage settings show account-level title and subtitle, then restore project labels', () => {
  const f = fixture(() => ({ usage: 2048 }));
  assert.match(f.container.innerHTML, /data-settings-title/);
  assert.match(f.container.innerHTML, /data-settings-subtitle/);
  f.panel.dataset.settingsScope = 'account';
  f.settings.show();
  assert.equal(f.title.textContent, 'en:recentProjects_settingsTitle');
  assert.equal(f.subtitle.textContent, 'en:recentProjects_settingsSubtitle');
  assert.equal(f.title.getAttribute('data-i18n'), 'recentProjects_settingsTitle');
  f.language.value = 'zh';
  f.language.emit('change');
  f.settings.loadState({});
  assert.equal(f.title.textContent, 'zh:recentProjects_settingsTitle');
  f.panel.dataset.settingsScope = 'project';
  f.settings.show();
  assert.equal(f.title.getAttribute('data-i18n'), 'projectSettingsTitle');
  assert.equal(f.subtitle.textContent, 'zh:projectSettingsSubtitle');
});

test('homepage storage reports site-wide usage without fabricated project or session counts', async () => {
  const f = fixture(() => ({ usage: 2048 }));
  f.panel.dataset.settingsScope = 'account';
  f.setProject(null);
  await f.maintenance.refreshStorageUsageSummary();
  assert.match(f.usage.textContent, /^Saved history across projects in this browser/);
  assert.match(f.usage.textContent, /Site total ~2 KB/);
  assert.doesNotMatch(f.usage.textContent, /loaded session|active session|this project|loaded conversations|runs in this project/);
  f.card.open = true;
  f.language.value = 'zh';
  f.language.emit('change');
  await settle();
  assert.match(f.usage.textContent, /\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d\u8de8\u9879\u76ee\u4fdd\u5b58\u7684\u5386\u53f2/);
  assert.doesNotMatch(f.usage.textContent, /\u5f53\u524d\u9879\u76ee|\u5f53\u524d\u4f1a\u8bdd|\u672c\u9879\u76ee|\d+\s*\u4e2a\u5bf9\u8bdd|\d+\s*\u8f6e\u8fd0\u884c/);
});

test('homepage storage keeps its global scope when capacity estimation is unavailable', async () => {
  const f = fixture();
  f.panel.dataset.settingsScope = 'account';
  await f.maintenance.refreshStorageUsageSummary();
  assert.match(f.usage.textContent, /^Saved history across projects in this browser.*estimate unavailable/);
  assert.doesNotMatch(f.usage.textContent, /loaded session|active session|this project|loaded conversations|runs in this project/);
});
