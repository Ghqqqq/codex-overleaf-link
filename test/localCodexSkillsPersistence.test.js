'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Preferences = require('../extension/src/shared/globalPreferences');
const GlobalController = require('../extension/src/content/globalPreferencesController');
const SessionState = require('../extension/src/shared/sessionState');
const StorageDb = require('../extension/src/shared/storageDb');
const Queue = require('../extension/src/shared/runInputQueue');
const RunController = require('../extension/src/content/runController');
const ForkController = require('../extension/src/content/sessionForkController');

function preferenceHarness(initial) {
  const data = initial ? { [Preferences.STORAGE_KEY]: structuredClone(initial) } : {};
  const listeners = new Set();
  let writeError = false;
  const local = {
    async get(keys) { return structuredClone(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]))); },
    async set(values) {
      if (writeError) throw new Error('write failed');
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { newValue: structuredClone(value), oldValue: data[key] };
        data[key] = structuredClone(value);
      }
      for (const listener of listeners) listener(changes, 'local');
    }
  };
  const store = Preferences.createStore(local);
  const chromeApi = { storage: { local, onChanged: {
    addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn)
  } }, runtime: { async sendMessage(message) {
    try { return { ok: true, result: message.type === Preferences.READ_MESSAGE
      ? await store.read() : await store.patch(message.patch) }; }
    catch (error) { return { ok: false, error: { message: error.message } }; }
  } } };
  return { data, store, chromeApi, failWrites() { writeError = true; } };
}

function preferencePage(harness) {
  let state = { task: 'keep draft', sessions: [{ id: 'session-a' }] };
  const errors = [];
  let skillsChanges = 0;
  const controller = GlobalController.create({ chromeApi: harness.chromeApi,
    getState: () => state, setState: next => { state = next; },
    getPanel: () => ({ querySelector: () => null }),
    onSkillsChange: () => { skillsChanges += 1; }, onError: error => errors.push(error.message) });
  return { controller, errors, state: () => state, skillsChanges: () => skillsChanges };
}

const localId = n => 'local-' + String(n).padStart(64, '0');
const localIds = count => Array.from({ length: count }, (_, index) => localId(index));

test('pre-local-selection v1 snapshots remain readable without pinning source defaults', async () => {
  const values = Preferences.pick({ locale: 'zh', loadCodexLocalSkills: false,
    codexOverleafSkillEnabled: { rewrite: false } });
  delete values.codexLocalSkillEnabled;
  const old = { schemaVersion: 1, revision: 9, values };
  const h = preferenceHarness(old);
  const read = await h.store.read();
  assert.equal(read.revision, 9);
  assert.equal(read.values.loadCodexLocalSkills, false);
  assert.deepEqual(read.values.codexOverleafSkillEnabled, { rewrite: false });
  assert.deepEqual(read.values.codexLocalSkillEnabled, {});
  assert.deepEqual(h.data[Preferences.STORAGE_KEY], old, 'reading old preferences does not rewrite unrelated data');
  const saved = await h.store.patch({ codexLocalSkillEnabled: { [localId(1)]: true } });
  assert.equal(saved.revision, 10);
  assert.deepEqual(saved.values.codexLocalSkillEnabled, { [localId(1)]: true });
  assert.equal(Object.hasOwn(saved.values.codexLocalSkillEnabled, localId(2)), false);
});

test('concurrent local toggles merge across tabs without replacing Overleaf skills or drafts', async () => {
  const h = preferenceHarness();
  const first = preferencePage(h);
  const second = preferencePage(h);
  await Promise.all([first.controller.initialize(), second.controller.initialize()]);
  await Promise.all([
    first.controller.update({ codexLocalSkillEnabled: { [localId(1)]: false } }),
    second.controller.update({ codexLocalSkillEnabled: { [localId(2)]: true } }),
    h.store.patch({ codexOverleafSkillEnabled: { rewrite: false } })
  ]);
  for (const page of [first, second]) {
    assert.deepEqual(page.state().codexLocalSkillEnabled, { [localId(1)]: false, [localId(2)]: true });
    assert.deepEqual(page.state().codexOverleafSkillEnabled, { rewrite: false });
    assert.equal(page.state().task, 'keep draft');
    assert.deepEqual(page.state().sessions, [{ id: 'session-a' }]);
    assert.ok(page.skillsChanges() > 0);
    page.controller.destroy();
  }
});

test('failed local preference writes restore inherited selection and surface the failure', async () => {
  const h = preferenceHarness();
  const page = preferencePage(h);
  await page.controller.initialize();
  h.failWrites();
  await assert.rejects(page.controller.update({ codexLocalSkillEnabled: { [localId(1)]: false } }), /write failed/);
  assert.deepEqual(page.state().codexLocalSkillEnabled, {});
  assert.deepEqual((await h.store.read()).values.codexLocalSkillEnabled, {});
  assert.deepEqual(page.errors, ['write failed']);
  page.controller.destroy();
});

test('local preference capacity rejects an additional override without truncating retained choices', async () => {
  const h = preferenceHarness();
  const full = Object.fromEntries(localIds(200).map(id => [id, false]));
  await h.store.patch({ codexLocalSkillEnabled: full });
  await assert.rejects(h.store.patch({ codexLocalSkillEnabled: { [localId(201)]: false } }), /Too many skill preferences/);
  assert.deepEqual((await h.store.read()).values.codexLocalSkillEnabled, full);
  const overflow = { ...full, [localId(201)]: false };
  assert.throws(() => Preferences.pick({ codexLocalSkillEnabled: overflow }), /Too many skill preferences/);
  assert.throws(() => SessionState.normalizePanelState({ codexLocalSkillEnabled: overflow }), /Too many skill preferences/);
  assert.throws(() => StorageDb.extractLightweightPrefs({ codexLocalSkillEnabled: overflow }), /Too many skill preferences/);
  for (const map of [{ '../escape': true }, { constructor: true }, { valid: 'true' }]) {
    await assert.rejects(h.store.patch({ codexLocalSkillEnabled: map }));
  }
});

test('panel switching and both storage projections retain only explicit local preferences', () => {
  const state = SessionState.normalizePanelState({ codexLocalSkillEnabled: { [localId(1)]: false, [localId(2)]: true, invalid: 'true' },
    codexLocalSkills: [{ id: localId(1), description: 'transient catalog' }],
    activeSessionId: 'session-a', sessions: [{ id: 'session-a' }, { id: 'session-b' }] });
  const switched = SessionState.setActiveSession(state, 'session-b');
  const compact = SessionState.prepareStateForStorage(switched);
  const prefs = StorageDb.extractLightweightPrefs(compact, 'project-a');
  const hydrated = SessionState.normalizePanelState(prefs);
  for (const projection of [state, switched, compact, prefs, hydrated]) {
    assert.deepEqual(projection.codexLocalSkillEnabled, { [localId(1)]: false, [localId(2)]: true });
    assert.equal(Object.hasOwn(projection.codexLocalSkillEnabled, localId(3)), false);
  }
  assert.equal(Object.hasOwn(compact, 'codexLocalSkills'), false);
  assert.equal(Object.hasOwn(prefs, 'codexLocalSkills'), false);
  assert.deepEqual(SessionState.normalizePanelState({}).codexLocalSkillEnabled, {});
});

test('local allowlists and explicit invocation survive enqueue, reload and native request projection', () => {
  const ids = localIds(240);
  const invocation = { id: ids[239], title: 'Long catalog choice', scope: 'codex-local' };
  const submitted = { customInstructions: 'captured', skillLoadingSettings: { loadCodexLocalSkills: true, loadCodexOverleafSkills: true },
    enabledCodexLocalSkillIds: ids, enabledCodexOverleafSkillIds: ['rewrite'], skillInvocation: invocation };
  const enqueued = Queue.enqueue([], { id: 'queued-a', text: 'apply local skill', payload: { submissionContext: submitted } });
  assert.equal(enqueued.ok, true);
  submitted.enabledCodexLocalSkillIds.splice(0, ids.length);
  submitted.skillInvocation.title = 'later draft';
  const stored = StorageDb.buildSessionRecord({ id: 'session-a', projectId: 'project-a', pendingInputs: enqueued.queue });
  const hydrated = SessionState.normalizePanelState({ sessions: [stored], activeSessionId: stored.id });
  const [restored] = Queue.normalizeQueue(Queue.compactForStorage(hydrated.sessions[0].pendingInputs));
  const context = restored.payload.submissionContext;
  assert.equal(context.enabledCodexLocalSkillIds.length, 240, 'catalog size never silently truncates the run allowlist');
  assert.equal(context.skillInvocation.title, 'Long catalog choice');
  assert.equal(context.skillInvocation.scope, 'codex-local');
  const native = RunController.buildCodexRunParams({ currentProjectId: 'project-a', task: restored.text, ...context });
  assert.deepEqual(native.enabledCodexLocalSkillIds, localIds(240));
  assert.deepEqual(native.enabledCodexOverleafSkillIds, ['rewrite']);
  assert.deepEqual(native.skillInvocation, { id: localId(239), title: 'Long catalog choice', scope: 'codex-local' });
});

test('legacy absence and explicit empty local allowlists stay distinct through queue and Native', () => {
  for (const value of [undefined, []]) {
    const context = Queue.normalizeSubmissionContext({ enabledCodexLocalSkillIds: value });
    const [restored] = Queue.normalizeQueue(Queue.compactForStorage([
      { id: 'queued-a', text: 'task', payload: { submissionContext: context } }
    ]));
    const projected = restored.payload.submissionContext;
    assert.equal(Object.hasOwn(projected, 'enabledCodexLocalSkillIds'), value !== undefined);
    const native = RunController.buildCodexRunParams(projected);
    assert.deepEqual(native.enabledCodexLocalSkillIds, value);
  }
  const [legacy] = Queue.normalizeQueue([{ id: 'legacy', text: 'old task' }]);
  assert.equal(Object.hasOwn(legacy.payload, 'submissionContext'), false);
});

test('oversized queue selection is rejected with the original queue intact', () => {
  const previous = Queue.enqueue([], { id: 'first', text: 'keep this' }).queue;
  const result = Queue.enqueue(previous, { id: 'second', text: 'too large', payload: {
    submissionContext: { enabledCodexLocalSkillIds: localIds(2200) }
  } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'queue_too_large');
  assert.deepEqual(result.queue, previous);
});

test('scope distinguishes same-name local/Overleaf skills from the built-in installer', () => {
  for (const scope of ['codex-local', 'codex-overleaf']) {
    const value = { id: 'skill-installer', title: 'Same name', scope };
    assert.deepEqual(RunController.normalizeSkillInvocation(value), value);
    assert.deepEqual(Queue.normalizeSubmissionContext({ skillInvocation: value }).skillInvocation, value);
  }
  for (const scope of [undefined, 'builtin']) {
    const value = { id: 'skill-installer', title: 'Installer', scope };
    const expected = { id: 'skill-installer', title: 'Installer' };
    assert.deepEqual(RunController.normalizeSkillInvocation(value), expected);
    assert.deepEqual(Queue.normalizeSubmissionContext({ skillInvocation: value }).skillInvocation, expected);
  }
  for (const value of [{ id: 'skill-installer', scope: 'unknown' }, { id: '../escape', scope: 'codex-local' }, { id: 'constructor', scope: 'codex-local' }]) {
    assert.equal(RunController.normalizeSkillInvocation(value), null);
    assert.equal(Queue.normalizeSubmissionContext({ skillInvocation: value }).skillInvocation, null);
  }
});

test('fork captures local selection once and preserves absence for legacy callers', async () => {
  for (const selected of [undefined, [], [localId(1)]]) {
    let state = SessionState.normalizePanelState({ sessions: [{ id: 'source', codexThreadId: 'thread-source',
      runs: [{ id: 'origin', status: 'completed', codexTurnId: 'turn-source' }] }] });
    let captured;
    const controller = ForkController.create({ SessionState, getState: () => state, setState: next => { state = next; },
      ...(selected === undefined ? {} : { getEnabledCodexLocalSkillIds: () => selected }),
      async sendBackgroundNative(request) {
        captured = request;
        if (selected) selected.push(localId(2));
        return { ok: true, result: { threadId: 'thread-fork' } };
      }, saveState: async () => {}, applyStateToPanel() {}, showPluginToast() {}, tr: key => key });
    const expected = selected && [...selected];
    await controller.forkRunFromNode('origin');
    assert.deepEqual(captured.params.enabledCodexLocalSkillIds, expected);
  }
});

function deferredLocalCatalogFork({ enabled = true, overrides = { [localId(1)]: false }, resolve } = {}) {
  let state = SessionState.normalizePanelState({ loadCodexLocalSkills: enabled, loadCodexOverleafSkills: true,
    codexLocalSkillEnabled: overrides, sessions: [{ id: 'source', codexThreadId: 'thread-source',
      runs: [{ id: 'origin', status: 'completed', codexTurnId: 'turn-source' }] }] });
  let scope = { accountScopeId: 'account-a', projectId: 'project-a', generation: 1 };
  const requests = [];
  const notices = [];
  const controller = ForkController.create({ SessionState, getState: () => state,
    setState: next => { state = next; }, getScope: () => scope,
    captureLocalSkillIdsForFork: resolve,
    async sendBackgroundNative(request) { requests.push(request); return { ok: true, result: { threadId: 'thread-fork' } }; },
    saveState: async () => {}, applyStateToPanel() {}, showPluginToast: message => notices.push(message), tr: key => key });
  return { controller, requests, notices, state: () => state, moveScope() { scope = { ...scope, projectId: 'project-b', generation: 2 }; } };
}

test('fork waits for its catalog using captured master settings and override map', async () => {
  let finish;
  let captured;
  const h = deferredLocalCatalogFork({ resolve: async preferences => {
    captured = preferences;
    await new Promise(resolve => { finish = resolve; });
    return [localId(1), localId(2)].filter(id => preferences.codexLocalSkillEnabled[id] !== false);
  } });
  const pending = h.controller.forkRunFromNode('origin');
  assert.equal(h.requests.length, 0);
  h.state().loadCodexLocalSkills = false;
  h.state().loadCodexOverleafSkills = false;
  h.state().codexLocalSkillEnabled[localId(1)] = true;
  h.state().codexLocalSkillEnabled[localId(2)] = false;
  finish();
  await pending;
  assert.deepEqual(captured.codexLocalSkillEnabled, { [localId(1)]: false });
  assert.equal(h.requests[0].params.loadCodexLocalSkills, true);
  assert.equal(h.requests[0].params.loadCodexOverleafSkills, true);
  assert.deepEqual(h.requests[0].params.enabledCodexLocalSkillIds, [localId(2)]);
});

test('fork with local skills off captures an empty allowlist without reading the catalog', async () => {
  const h = deferredLocalCatalogFork({ enabled: false, resolve() { throw new Error('catalog should not be queried'); } });
  await h.controller.forkRunFromNode('origin');
  assert.equal(h.requests[0].params.loadCodexLocalSkills, false);
  assert.deepEqual(h.requests[0].params.enabledCodexLocalSkillIds, []);
});

test('fork fails visibly without dispatching when the required local catalog fails or stays unknown', async () => {
  for (const resolve of [async () => { throw Object.assign(new Error('Local skill catalog unavailable'), { code: 'codex_local_skill_unavailable' }); }, () => undefined]) {
    const h = deferredLocalCatalogFork({ resolve });
    await assert.rejects(h.controller.forkRunFromNode('origin'), error => error.code === 'codex_local_skill_unavailable');
    assert.equal(h.requests.length, 0);
    assert.equal(h.notices.length, 1);
    assert.equal(h.state().sessions.length, 1);
  }
});

test('fork never dispatches after the scope or source changes while awaiting its local catalog', async () => {
  for (const change of [h => h.moveScope(), h => { h.state().sessions[0].runs[0].codexTurnId = 'replacement-turn'; }]) {
    let finish;
    const h = deferredLocalCatalogFork({ resolve: () => new Promise(resolve => { finish = resolve; }) });
    const pending = h.controller.forkRunFromNode('origin');
    change(h);
    finish([localId(2)]);
    assert.equal(await pending, null);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.notices, []);
  }
});
