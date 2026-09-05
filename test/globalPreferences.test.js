const assert = require('node:assert/strict');
const test = require('node:test');
const Preferences = require('../extension/src/shared/globalPreferences');
const Controller = require('../extension/src/content/globalPreferencesController');
const PanelState = require('../extension/src/content/scopedPersistencePanelState');
const StorageDb = require('../extension/src/shared/storageDb');
const SessionState = require('../extension/src/shared/sessionState');

function harness(legacy = {}) {
  const data = { [Preferences.LEGACY_KEY]: structuredClone(legacy) };
  const listeners = new Set();
  let readError = false;
  let writeError = false;
  const storage = {
    local: {
      async get(keys) {
        if (readError) throw new Error('read failed');
        const names = Array.isArray(keys) ? keys : [keys];
        return structuredClone(Object.fromEntries(names.filter(key => key in data).map(key => [key, data[key]])));
      },
      async set(values) {
        if (writeError) throw new Error('write failed');
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        for (const listener of listeners) listener(changes, 'local');
      }
    },
    onChanged: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) }
  };
  const store = Preferences.createStore(storage.local);
  const chromeApi = { storage, runtime: {
    async sendMessage(message) {
      try {
        return { ok: true, result: message.type === Preferences.READ_MESSAGE
          ? await store.read() : await store.patch(message.patch) };
      } catch (error) { return { ok: false, error: { message: error.message } }; }
    }
  } };
  return { data, store, chromeApi, listeners,
    failRead: value => { readError = value; }, failWrite: value => { writeError = value; } };
}

function windowController(h) {
  let state = { theme: 'dark', task: 'unsent draft', sessions: [{ id: 'local-session' }] };
  const errors = [];
  const controller = Controller.create({ chromeApi: h.chromeApi,
    getState: () => state, setState: next => { state = next; }, getPanel: () => null,
    onError: error => errors.push(error.message) });
  return { controller, errors, get state() { return state; } };
}

test('dashboard without a project migrates global preferences and keeps explicit false', async () => {
  const h = harness({ theme: 'light', locale: 'zh', preloadProjectContext: false,
    loadCodexLocalSkills: false, codexOverleafSkillEnabled: { rewrite: false }, model: 'project-model' });
  const page = windowController(h);
  await page.controller.initialize();
  assert.equal(page.state.theme, 'light');
  assert.equal(page.state.locale, 'zh');
  assert.equal(page.state.preloadProjectContext, false);
  assert.equal(page.state.loadCodexLocalSkills, false);
  assert.deepEqual(page.state.codexOverleafSkillEnabled, { rewrite: false });
  assert.equal(Object.hasOwn(h.data[Preferences.STORAGE_KEY].values, 'model'), false);
  await page.controller.update({ theme: 'dark' });
  const reopened = windowController(h);
  await reopened.controller.initialize();
  assert.equal(reopened.state.theme, 'dark');
  assert.equal(reopened.state.preloadProjectContext, false);
});

test('two windows synchronize without losing drafts or project sessions', async () => {
  const h = harness({ theme: 'dark' });
  const a = windowController(h);
  const b = windowController(h);
  await Promise.all([a.controller.initialize(), b.controller.initialize()]);
  await a.controller.update({ theme: 'light', locale: 'zh', preloadProjectContext: false });
  assert.equal(b.state.theme, 'light');
  assert.equal(b.state.locale, 'zh');
  assert.equal(b.state.preloadProjectContext, false);
  assert.equal(b.state.task, 'unsent draft');
  assert.deepEqual(b.state.sessions, [{ id: 'local-session' }]);
  assert.equal(b.controller.overlay({ theme: 'dark', model: 'per-project' }).theme, 'light');
  assert.equal(b.controller.overlay({ model: 'per-project' }).model, 'per-project');
  a.controller.destroy(); b.controller.destroy();
  assert.equal(h.listeners.size, 0);
});

test('stale session autosave cannot roll back canonical global preferences', async () => {
  const h = harness({ theme: 'dark', locale: 'en' });
  await h.store.patch({ theme: 'light', preloadProjectContext: false });
  const staleState = { ...SessionState.DEFAULT_PANEL_STATE, theme: 'dark', sessions: [] };
  await PanelState.persistPanelState({
    state: staleState, compactState: SessionState.prepareStateForStorage(staleState),
    projectId: 'project-b', StorageDb,
    Migration: { async loadPrefs() { return h.data[Preferences.LEGACY_KEY]; },
      async savePrefs(value) { h.data[Preferences.LEGACY_KEY] = value; } },
    SessionPersistence: { async writeSessions() {} },
    normalizeExperimentalOtByProject: value => value || {},
    normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    persistenceContext: { scope: { accountScopeId: 'account-a', projectId: 'project-b' }, nextMeta: {} }
  });
  const reopened = windowController(h);
  await reopened.controller.initialize();
  assert.equal(reopened.state.theme, 'light');
  assert.equal(reopened.state.preloadProjectContext, false);
});

test('serialized patches preserve unrelated fields and independent skill toggles', async () => {
  const h = harness({ theme: 'dark' });
  const results = await Promise.all([
    h.store.patch({ theme: 'light' }), h.store.patch({ locale: 'zh' }),
    h.store.patch({ codexOverleafSkillEnabled: { first: false } }),
    h.store.patch({ codexOverleafSkillEnabled: { second: false } })
  ]);
  assert.equal(new Set(results.map(result => result.revision)).size, 4);
  const result = await h.store.read();
  assert.equal(result.values.theme, 'light');
  assert.equal(result.values.locale, 'zh');
  assert.deepEqual(result.values.codexOverleafSkillEnabled, { first: false, second: false });
});

test('delayed responses and stale events cannot override a newer revision', async () => {
  const h = harness();
  const page = windowController(h);
  await page.controller.initialize();
  await page.controller.update({ theme: 'light' });
  const stale = await h.store.read();
  await h.store.patch({ theme: 'dark' });
  for (const listener of h.listeners) listener({ [Preferences.STORAGE_KEY]: { newValue: stale } }, 'local');
  assert.equal(page.state.theme, 'dark');
});

test('failed reads never replace existing settings with defaults, and retries recover', async () => {
  const h = harness({ theme: 'light' });
  const saved = await h.store.read();
  h.failRead(true);
  const page = windowController(h);
  await page.controller.initialize();
  assert.deepEqual(h.data[Preferences.STORAGE_KEY], saved);
  assert.equal(page.controller.overlay({ theme: 'auto' }).theme, 'auto');
  h.failRead(false);
  await page.controller.initialize();
  assert.equal(page.state.theme, 'light');
});

test('an older startup response cannot override a preference event received while loading', async () => {
  const h = harness({ theme: 'dark' });
  const old = await h.store.read();
  let releaseRead;
  h.chromeApi.runtime.sendMessage = async message => message.type === Preferences.READ_MESSAGE
    ? new Promise(resolve => { releaseRead = () => resolve({ ok: true, result: old }); })
    : { ok: true, result: await h.store.patch(message.patch) };
  const page = windowController(h);
  const loading = page.controller.initialize();
  await h.store.patch({ theme: 'light' });
  releaseRead();
  await loading;
  assert.equal(page.state.theme, 'light');
});

test('startup errors are reported again when the panel becomes available', async () => {
  const h = harness({ theme: 'light' });
  let panel = null;
  const visibleErrors = [];
  h.failRead(true);
  const controller = Controller.create({ chromeApi: h.chromeApi, getState: () => ({}),
    getPanel: () => panel, onError: error => { if (panel) visibleErrors.push(error.message); } });
  await controller.initialize();
  assert.deepEqual(visibleErrors, []);
  panel = { querySelector: () => null };
  controller.refreshView();
  assert.deepEqual(visibleErrors, ['read failed']);
  assert.equal(h.data[Preferences.STORAGE_KEY], undefined);
});

test('rapid local toggles keep the latest selection while earlier writes are pending', async () => {
  const h = harness({ theme: 'dark' });
  const page = windowController(h);
  await page.controller.initialize();
  let releaseFirst;
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let requestCount = 0;
  h.chromeApi.runtime.sendMessage = async message => {
    const result = await h.store.patch(message.patch);
    if (++requestCount === 1) {
      started();
      return new Promise(resolve => { releaseFirst = () => resolve({ ok: true, result }); });
    }
    return { ok: true, result };
  };
  const first = page.controller.update({ theme: 'light' });
  await firstStarted;
  const second = page.controller.update({ theme: 'dark' });
  assert.equal(page.state.theme, 'dark');
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(page.state.theme, 'dark');
  assert.equal((await h.store.read()).values.theme, 'dark');
});

test('failed writes are surfaced, revert optimistic state and leave the store unchanged', async () => {
  const h = harness({ theme: 'light' });
  const page = windowController(h);
  await page.controller.initialize();
  h.failWrite(true);
  await assert.rejects(page.controller.update({ theme: 'dark' }), /write failed/);
  assert.equal(page.state.theme, 'light');
  assert.equal(h.data[Preferences.STORAGE_KEY].values.theme, 'light');
  assert.ok(page.errors.includes('write failed'));
});

test('invalid or project-scoped patches are rejected without changing global storage', async () => {
  const h = harness({ theme: 'light' });
  const original = await h.store.read();
  for (const patch of [{ theme: 'neon' }, { preloadProjectContext: 'false' }, { providerId: 'foreign' }, { codexOverleafSkillEnabled: { '__proto__': false, valid: 'no' } }]) {
    await assert.rejects(h.store.patch(patch));
  }
  assert.deepEqual(await h.store.read(), original);
});

test('background accepts dashboard and project tabs and rejects unrelated senders', async () => {
  const h = harness();
  const handlers = [];
  const chromeApi = { ...h.chromeApi, runtime: { id: 'this-extension',
    onMessage: { addListener: listener => handlers.push(listener) } } };
  Preferences.installBackground(chromeApi);
  const call = sender => new Promise(resolve => handlers[0]({ type: Preferences.READ_MESSAGE }, sender, resolve));
  assert.equal((await call({ id: 'this-extension', tab: { url: 'https://www.overleaf.com/project' } })).ok, true);
  assert.equal((await call({ id: 'this-extension', tab: { url: 'https://overleaf.com/project/abc' } })).ok, true);
  assert.equal((await call({ id: 'other-extension', tab: { url: 'https://overleaf.com/project/abc' } })).ok, false);
  assert.equal((await call({ id: 'this-extension', tab: { url: 'https://example.com/project' } })).ok, false);
});
