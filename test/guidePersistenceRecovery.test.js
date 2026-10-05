'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');
const repo = path.resolve(__dirname, '..');
const req = file => require(path.join(repo, file));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const { harness: runHarness, deferred } = req('test/_helpers/runSubmissionHarness.js');
const { extractFunction } = req('test/_helpers/extractFunction.js');
const Queue = req('extension/src/shared/runInputQueue.js');
const Scheduler = req('extension/src/content/runQueueScheduler.js');
const Session = req('extension/src/shared/sessionState.js');
const Storage = req('extension/src/shared/storageDb.js');
const Scoped = req('extension/src/content/scopedPersistenceCoordinator.js');
const Transaction = req('extension/src/shared/scopedPersistenceTransaction.js');
const Persistence = req('extension/src/content/sessionPersistence.js');
const Compatibility = req('extension/src/shared/compatibility.js');
const CompatibilityController = req('extension/src/content/nativeCompatibilityController.js');
const source = read('extension/src/content/contentRuntime.js');
const P1 = '111111111111111111111111', P2 = '222222222222222222222222';
const clone = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) { for (let i = 0; i < 500; i++) { if (predicate()) return; await tick(); } throw new Error('Fixture wait exceeded: ' + label); }
function gate() { const entered = deferred(), released = deferred(); let used = false; return { entered: entered.promise, release: released.resolve,
  async wait() { if (used) return; used = true; entered.resolve(); await released.promise; } }; }
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.value = ''; this.disabled = false; this.text = ''; }
  set textContent(value) { this.children = []; this.text = String(value ?? ''); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async click() { if (this.disabled) return false; for (const fn of this.listeners.click || []) await fn(); return true; }
  all(className) { return this.children.flatMap(child => [...(child.className.split(/\s+/).includes(className) ? [child] : []), ...child.all(className)]); }
  focus() {} setSelectionRange() {} dispatchEvent() {}
}
function ui(container) { return { hidden: container.hidden, header: container.dataset.state || '',
  textDisabled: container.all('codex-pending-input-text').map(n => n.disabled),
  removeDisabled: container.all('codex-pending-input-remove').map(n => n.disabled),
  guideCount: container.all('codex-pending-steer').length, resumeCount: container.all('codex-pending-resume').length }; }
function normalizedQueue(q) { return (q || []).map(x => ({ id: x.id, text: x.text, status: x.status, pauseReason: x.pauseReason || '', claimToken: x.claimToken || '' })); }
function setup({ providerGate = false, commitGate = '', storageFailure = false } = {}) {
  const h = runHarness(providerGate ? 'provider' : ''); const c = h.context;
  const meta = new Map(), records = new Map(), prefs = new Map(), locks = new Map();
  const logs = { saves: [], writes: [], removals: [], toasts: [], native: [], saveFallback: 0, stateWrites: 0 };
  const fault = { nextWrite: storageFailure, nextSessionWrite: false, nextFinalize: false, persistent: false }; const persistGate = gate(); let currentMutation = null, token = 0;
  const key = scope => scope.accountScopeId + ':' + scope.projectId;
  const adapter = {
    async read(scope) { return clone(meta.get(key(scope)) || { revision: 0 }); },
    async write(scope, value) { if (fault.nextWrite || fault.persistent || (fault.nextFinalize && !value.pendingCommit)) { fault.nextWrite = false; fault.nextFinalize = false; throw Object.assign(new Error('synthetic storage unavailable'), { code: 'storage_unavailable' }); } meta.set(key(scope), clone(value)); logs.writes.push({ scope: key(scope), revision: value.revision, pending: Boolean(value.pendingCommit), mutation: currentMutation }); },
    withLock(scope, action) { const id = key(scope); const before = locks.get(id) || Promise.resolve();
      const work = before.then(async () => { if (commitGate && currentMutation === commitGate) await persistGate.wait(); return action(); });
      locks.set(id, work.catch(noop)); return work; }
  };
  const db = { ...Storage,
    async getAllByIndex(store, _index, projectId) { assert.equal(store, 'sessions'); return [...records.values()].filter(r => r.projectId === projectId).map(clone); },
    async putRecords(store, values) { assert.equal(store, 'sessions'); if (fault.nextSessionWrite) { fault.nextSessionWrite = false; throw Object.assign(new Error('synthetic session write unavailable'), { code: 'storage_unavailable' }); } for (const r of values) records.set(r.accountScopeId + ':' + r.projectId + ':' + r.id, clone(r)); logs.stateWrites++; return clone(values); },
    async getRecord(_store, id) { return clone([...records.values()].find(r => r.id === id) || null); },
    async putRecord(_store, r) { records.set(r.accountScopeId + ':' + r.projectId + ':' + r.id, clone(r)); return clone(r); },
    async deleteRecord(_store, id) { for (const [k, r] of records) if (r.id === id) records.delete(k); }
  };
  const migration = { async loadPrefs(account, project) { return clone(prefs.get(account + ':' + project) || {}); },
    async savePrefs(value, account, project) { prefs.set(account + ':' + project, clone(value)); },
    async loadSessionTombstones() { return {}; }, getDeletedSessionIds: () => [] };
  Object.assign(c, { PROJECT_EDITOR_RESERVED_IDS: new Set(['new', 'upload', 'import']), structuredClone,
    RunQueueScheduler: Scheduler, runInputCoordinator: null, scopedPersistenceCoordinator: null, spaRouteGeneration: 0,
    prepareStateForStorage: Session.prepareStateForStorage, notifyAggressiveCompactionOnce: noop,
    getCodexOverleafSkillEnabled: () => ({}), normalizeExperimentalOtByProject: x => x || {},
    normalizeGovernanceRulesByProject: x => x || {}, normalizeCustomInstructionsByProject: x => x || {},
    chrome: { storage: { local: { async set() { logs.saveFallback++; } } } }, storageKey: 'synthetic',
    buildScopedFallbackStorageKey: () => 'synthetic-fallback', prepareCompactFallbackState: () => ({}),
    isStorageQuotaError: () => false, appendStorageNoticeOnce: noop,
    showPluginToast: text => logs.toasts.push(text),
    runGuidanceController: { ...c.runGuidanceController, upsert: (text, input) => (logs.guidance ||= []).push({ text, ...input }), remove: id => logs.removals.push(id) },
    crypto: { randomUUID: () => 'synthetic-token-' + (++token) },
    sharedSessionViewSync: { beginSave: () => noop }, trackedChangeInFlight: new Map(),
    clearOtEventPolling: noop, clearMirrorPrefetchTimer: noop, releaseOtWarmMirrorProject: noop,
    callPageBridge: async method => { assert.equal(method, 'cancelActiveWrite'); return { ok: true }; },
    sendBackgroundNative: async request => { logs.native.push(clone(request)); return { ok: true }; }
  });
  c.nativeChannel.getActiveRequestId = () => c.currentRunView?.nativeRequestId || '';
  c.nativeCompatibilityController = CompatibilityController.create({ compatibility: Compatibility,
    gatedMethods: new Set(['codex.steer']), getExtensionCompatibilityMetadata: () => ({ version: Compatibility.BUILD_TARGET_VERSION }),
    getNativeCompatibilityClassification: value => value.classification, tx: en => en, tr: key => key,
    nativeChannel: { sendBackgroundNative: request => request.method === 'bridge.ping'
      ? Promise.resolve({ ok: true, result: { version: Compatibility.BUILD_TARGET_VERSION, protocolVersion: 2,
        supportedProtocol: { min: 1, max: 2 }, minExtensionVersion: '1.0.0',
        capabilities: Object.fromEntries(Compatibility.REQUIRED_CAPABILITIES.map(key => [key, true])), environment: { codex: { ok: true } } } })
      : c.sendBackgroundNative(request) }
  });
  c.window.location.pathname = '/project/' + P1; c.window.location.href = 'https://synthetic.invalid/project/' + P1;
  c.activeProjectId = P1;
  c.window.codexOverleafDeriveAccountScopeId = () => c.cachedAccountScopeId;
  c.window.sessionStorage = { getItem: () => 'synthetic-writer', setItem: noop };
  Object.assign(c.Modules, { StorageDb: db, StorageMigration: migration, ScopedPersistenceCoordinator: Scoped,
    ScopedPersistenceTransaction: { ...Transaction, createBrowserAdapter: () => adapter }, SessionPersistence: Persistence });
  for (const name of ['extractProjectIdFromLocation', 'isProjectEditorRoute', 'getCurrentProjectId',
    'getScopedPersistenceCoordinator', 'readLiveRunViewForSaveStateGuard', 'saveState',
    'initializeRunQueueScheduler', 'renderPendingInputs', 'leaveActiveProject', 'cancelPendingWritebacks',
    'pauseProjectObservers', 'disableComposer', 'cancelActiveRun']) vm.runInContext(extractFunction(source, name), c);
  c.getRunProjectSnapshot = async () => ({ id: c.getCurrentProjectId(), files: [{ path: 'main.tex', content: 'synthetic' }], capabilities: { fullProjectSnapshot: true } });
  const originalSave = c.saveState;
  c.saveState = async options => { currentMutation = options?.queueMutation?.type || ''; const row = { mutation: currentMutation, project: c.getCurrentProjectId(), runProject: c.currentRunView?.runProjectId || '', writesBefore: logs.stateWrites };
    logs.saves.push(row); try { const value = await originalSave(options); row.returned = value === undefined ? 'undefined' : value; row.writesAfter = logs.stateWrites; return value; } catch (error) { row.error = error.code || error.message; throw error; } };
  c.flushQueuedSaveState = () => c.saveState();
  const container = new Element('div'); const document = { createElement: t => new Element(t), createElementNS: (_ns, t) => new Element(t) };
  const viewContext = vm.createContext({ window: {}, document, Event: class { constructor(type) { this.type = type; } } });
  vm.runInContext(read('extension/src/content/pendingInputView.js'), viewContext);
  c.PendingInputView = viewContext.window.CodexOverleafPendingInputView;
  h.controls.set('[data-pending-inputs]', container); container.parentElement = { querySelector: selector => h.controls.get(selector) };
  c.initializeRunQueueScheduler();
  let queuedId;
  async function enqueue() {
    h.type('synthetic queued instruction'); c.runInputCoordinator.queueComposerInput();
    queuedId = c.getActiveSession(c.state).pendingInputs[0].id;
    await c.saveState({ queueMutation: { type: 'enqueue', sessionId: 'A', itemId: queuedId } });
    return queuedId;
  }
  function navigate(project) { c.window.location.pathname = project ? '/project/' + project : '/project'; c.window.location.href = 'https://synthetic.invalid' + c.window.location.pathname; c.leaveActiveProject(project || null); }
  const observe = () => ({ project: c.getCurrentProjectId(), pending: normalizedQueue(c.findSessionById('A')?.pendingInputs),
    stored: [...records.values()].filter(r => r.id === 'A').map(r => ({ project: r.projectId, account: r.accountScopeId, pending: normalizedQueue(r.pendingInputs), runs: (r.runs || []).map(x => ({ id: x.id, status: x.status, task: x.task, project: x.runProjectId })) })),
    runs: c.findSessionById('A')?.runs.map(x => ({ id: x.id, status: x.status, task: x.task, project: x.runProjectId })) || [],
    nativeRuns: h.io.requests.map(r => ({ task: r.task, projectId: r.projectId, accountScopeId: r.accountScopeId })),
    saves: logs.saves, UI: ui(container), toasts: logs.toasts, errors: h.io.errors });
  return { h, c, logs, meta, records, fault, persistGate, container, enqueue, navigate, observe,
    get itemId() { return queuedId; }, get queue() { return c.findSessionById('A')?.pendingInputs || []; } };
}

function activate(f) {
  f.c.currentRunView = { recordId: 'active-run', sessionId: 'A', runProjectId: P1,
    nativeRequestId: 'native-active', activeTurn: { threadId: 'thread-A', turnId: 'turn-A' } };
  f.c.runInputCoordinator.render();
}
function guideButton(f) {
  const button = f.container.all('codex-pending-steer')[0]; assert.ok(button, 'production view renders Guide'); return button;
}
function storedQueue(f) {
  return [...f.records.values()].find(record => record.id === 'A')?.pendingInputs || [];
}
function trackSends(f, send = async () => ({ ok: true })) {
  const sent = [];
  f.c.sendBackgroundNative = async request => { assert.equal(request.method, 'codex.steer'); sent.push(clone(request.params)); return send(request); };
  return sent;
}

test('normal Guide persists the transition, sends once with original binding, and removes the item', async () => {
  const f = setup(); await f.enqueue(); activate(f);
  const sent = trackSends(f, async () => {
    assert.equal(storedQueue(f)[0].status, 'steering', 'send follows actual session-record persistence');
    return { ok: true };
  });
  await guideButton(f).click();
  assert.equal(sent.length, 1);
  const { nativeCompatibility, ...sentBinding } = sent[0];
  assert.equal(nativeCompatibility.classification, 'compatible');
  assert.deepEqual(sentBinding, { requestId: 'native-active', projectKey: P1, threadId: 'thread-A', expectedTurnId: 'turn-A',
    clientUserMessageId: f.itemId, input: [{ type: 'text', text: 'synthetic queued instruction' }] });
  assert.equal(f.queue.length, 0); assert.equal(storedQueue(f).length, 0); assert.equal(ui(f.container).hidden, true);
  assert.equal(f.logs.guidance.length, 1);
});

for (const faultName of ['nextWrite', 'nextSessionWrite', 'nextFinalize']) test(`Guide restores an actionable unsent item after ${faultName} failure`, async () => {
  const f = setup(); await f.enqueue(); activate(f); const sent = trackSends(f);
  const original = clone(f.queue[0]); f.fault[faultName] = true;
  await guideButton(f).click();
  assert.equal(sent.length, 0, 'failed pre-send persistence must never reach Native');
  assert.equal(f.queue.length, 1); assert.equal(f.queue[0].id, original.id); assert.equal(f.queue[0].text, original.text);
  assert.equal(f.queue[0].status, 'queued'); assert.equal(storedQueue(f)[0].status, 'queued');
  assert.deepEqual(ui(f.container).textDisabled, [false]); assert.deepEqual(ui(f.container).removeDisabled, [false]);
  assert.equal(ui(f.container).guideCount, 1); assert.equal(Queue.claimNext(f.queue).ok, true);
  assert.equal(f.logs.toasts.length, 1, 'the original persistence failure remains visible');
  await guideButton(f).click();
  assert.equal(sent.length, 1, 'an explicit retry can send once because the failed attempt was never sent');
  assert.equal(f.queue.length, 0); assert.equal(storedQueue(f).length, 0);
});

test('a second persistence failure still leaves the unsent input editable and removable', async () => {
  const f = setup(); await f.enqueue(); activate(f); const sent = trackSends(f);
  f.fault.persistent = true;
  await guideButton(f).click();
  assert.equal(sent.length, 0); assert.equal(f.queue[0].status, 'queued');
  assert.equal(f.queue[0].text, 'synthetic queued instruction'); assert.equal(f.logs.toasts.length, 1);
  assert.deepEqual(ui(f.container).textDisabled, [false]); assert.deepEqual(ui(f.container).removeDisabled, [false]);
  assert.equal(storedQueue(f)[0].text, f.queue[0].text);
  f.fault.persistent = false;
  await f.container.all('codex-pending-input-remove')[0].click();
  assert.equal(f.queue.length, 0, 'restored removal action works without a send');
  assert.equal(sent.length, 0);
});

test('pre-send rollback preserves inputs queued while the first persistence call waits', async () => {
  const f = setup({ commitGate: 'transition' }); await f.enqueue(); activate(f); const sent = trackSends(f);
  const pending = guideButton(f).click(); await f.persistGate.entered;
  f.h.type('concurrent queued text'); f.c.runInputCoordinator.queueComposerInput();
  const secondId = f.queue[1].id;
  f.fault.nextWrite = true; f.persistGate.release(); await pending;
  assert.equal(sent.length, 0);
  assert.deepEqual(Array.from(f.queue, item => [item.id, item.status, item.text]), [
    [f.itemId, 'queued', 'synthetic queued instruction'], [secondId, 'queued', 'concurrent queued text']]);
  assert.equal(storedQueue(f).length, 2);
});

test('a second Guide call cannot duplicate an in-flight steering attempt', async () => {
  const f = setup({ commitGate: 'transition' }); await f.enqueue(); activate(f); const sent = trackSends(f);
  const pending = guideButton(f).click(); await f.persistGate.entered;
  const duplicate = f.c.runInputCoordinator.guide(f.itemId);
  await tick(); assert.equal(sent.length, 0); f.persistGate.release(); await Promise.all([pending, duplicate]);
  assert.equal(sent.length, 1); assert.equal(f.queue.length, 0);
});

for (const failRecoverySave of [false, true]) test(`uncertain delivery remains paused without automatic resend (save failure=${failRecoverySave})`, async () => {
  const f = setup(); await f.enqueue(); activate(f);
  const sent = trackSends(f, async () => { if (failRecoverySave) f.fault.persistent = true; throw new Error('synthetic transport outcome unknown'); });
  await guideButton(f).click();
  assert.equal(sent.length, 1); assert.equal(f.queue[0].status, 'paused'); assert.equal(f.queue[0].pauseReason, 'steer_delivery_unknown');
  assert.equal(f.queue[0].text, 'synthetic queued instruction'); assert.equal(ui(f.container).guideCount, 0);
  assert.equal(ui(f.container).resumeCount, 1); assert.deepEqual(ui(f.container).removeDisabled, [false]);
  await f.c.runInputCoordinator.guide(f.itemId);
  assert.equal(sent.length, 1, 'unknown delivery cannot be resubmitted through Guide');
  f.c.currentRunView = null;
  assert.equal(f.c.runQueueScheduler.scheduleOne('A'), false);
  const recovered = Queue.normalizeQueue(storedQueue(f), { recoverActive: true });
  assert.equal(recovered.length, 1); assert.equal(recovered[0].status, 'paused');
  assert.equal(recovered[0].text, 'synthetic queued instruction');
});

for (const change of ['remove', 'replace-item', 'replace-session', 'pause', 'account', 'project', 'route-generation']) {
  test(`a failed pre-send save cannot overwrite concurrent ${change}`, async () => {
    const f = setup({ commitGate: 'transition' }); await f.enqueue(); activate(f); const sent = trackSends(f);
    const pending = guideButton(f).click(); await f.persistGate.entered;
    if (change === 'remove') f.c.updateSessionById('A', { pendingInputs: [] });
    if (change === 'replace-item') f.c.updateSessionById('A', { pendingInputs: [{ ...clone(f.queue[0]), text: 'replacement text', clientUserMessageId: 'replacement-message' }] });
    if (change === 'replace-session') f.c.updateSessionById('A', { createdAt: '2040-01-01T00:00:00Z' });
    if (change === 'pause') f.c.updateSessionById('A', { pendingInputs: Queue.pauseAll(f.queue, 'explicit-pause') });
    if (change === 'account') f.c.cachedAccountScopeId = 'different-account';
    if (change === 'project') {
      f.c.activeProjectId = P2; f.c.window.location.pathname = '/project/' + P2;
      f.c.window.location.href = 'https://synthetic.invalid/project/' + P2;
    }
    if (change === 'route-generation') f.c.spaRouteGeneration++;
    const expected = clone(f.queue), saveCount = f.logs.saves.length;
    f.fault.nextWrite = true; f.persistGate.release(); await pending;
    assert.equal(sent.length, 0); assert.deepEqual(clone(f.queue), expected);
    assert.equal(f.logs.saves.length, saveCount, 'no compensating write can target a replaced owner');
  });
}

test('an explicitly resumed unknown-delivery item can be guided after resuming, with no automatic resend', async () => {
  const f = setup(); await f.enqueue(); activate(f);
  let unknown = true;
  const sent = trackSends(f, async () => { if (unknown) throw new Error('synthetic unknown delivery'); return { ok: true }; });
  await guideButton(f).click(); assert.equal(sent.length, 1);
  unknown = false;
  await f.container.all('codex-pending-resume')[0].click();
  await until(() => ui(f.container).guideCount === 1, 'resume persistence and UI');
  assert.equal(sent.length, 1, 'Resume alone does not resend guidance to the active turn');
  await guideButton(f).click(); assert.equal(sent.length, 2); assert.equal(f.queue.length, 0);
});

test('after a pre-send persistence failure the real scheduler can later promote the preserved input', async () => {
  const f = setup(); await f.enqueue(); activate(f); const sent = trackSends(f);
  f.fault.nextWrite = true; await guideButton(f).click();
  assert.equal(sent.length, 0); f.c.currentRunView = null;
  assert.equal(f.c.runQueueScheduler.scheduleOne('A'), true);
  await until(() => f.h.io.requests.length === 1 && f.c.currentRunView === null, 'restored queue execution');
  assert.equal(f.h.io.requests[0].task, 'synthetic queued instruction');
  assert.equal(f.queue.length, 0); assert.equal(storedQueue(f).length, 0);
});
