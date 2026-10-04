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
  const fault = { dropCheck: false, nextWrite: storageFailure, nextSessionWrite: false, nextFinalize: false, persistent: false }; const persistGate = gate(); let currentMutation = null, token = 0;
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
    async putRecords(store, values) { assert.equal(store, 'sessions'); if (fault.nextSessionWrite) { fault.nextSessionWrite = false; throw Object.assign(new Error('synthetic session write unavailable'), { code: 'storage_unavailable' }); } for (const r of values) { if (fault.dropCheck) for (const run of r.runs || []) delete run.writebackCheck; } for (const r of values) records.set(r.accountScopeId + ':' + r.projectId + ':' + r.id, clone(r)); logs.stateWrites++; return clone(values); },
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
  c.saveState = async options => { currentMutation = options?.queueMutation?.type || (options?.reviewRunIds?.length ? 'review' : ''); const row = { mutation: currentMutation, project: c.getCurrentProjectId(), runProject: c.currentRunView?.runProjectId || '', writesBefore: logs.stateWrites };
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

const Verification = req('extension/src/content/writebackVerificationController');
const Writeback = req('extension/src/content/writebackController');
const Plan = req('extension/src/content/writebackPlan');
const Contract = req('extension/src/shared/pageRpcContract');
const { harness: pageHarness } = req('test/_helpers/binaryWritebackHarness');
async function writebackRuntime(t, options = {}) {
  const f = setup(options), c = f.c;
  const page = await pageHarness(t, { projectId: P1, dropReply: options.dropReply ? 'applyOperations' : '' });
  const plan = Plan.create({ tx: en => en, tr: key => key, normalizeSafeProjectPath: req('extension/src/shared/projectFiles').normalizeSafeProjectPath });
  Object.assign(c, plan, { writebackVerificationController: null, writebackController: Writeback,
    saveStateTimer: null, saveStateInFlight: false, saveStateRunAfterFlight: false, saveStateInFlightPromise: null, pendingSaveStateOptions: null,
    setTimeout, clearTimeout, updateIdleClient: null, renderRunHistory() {}, HIGH_RISK_TYPES: ['delete', 'overwrite-binary'],
    formatOperationFiles: ops => ops.map(op => op.path).join(','), localizeVisibleReason: text => text,
    formatStateSaveError: error => error.message, emitStorageQuotaFailure() {},
    getSkippedEntries: value => Array.isArray(value?.skipped) ? value.skipped : [],
    writeCalls: 0, pageMethods: [],
    async callPageBridge(method, params) {
      c.pageMethods.push(method);
      if (method === 'ensureEditing') return { ok: true };
      if (method === 'getProjectSnapshot') return { id: P1, capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip' },
        files: [...page.textFiles].map(([path, content]) => ({ path, content, source: 'overleaf-zip' })) };
      assert.equal(method, 'applyOperations');
      const stored = [...f.records.values()].find(record => record.id === 'A');
      assert.ok(stored?.runs.find(run => run.id === 'writeback-run')?.writebackCheck, 'actual stored record exists before the write RPC');
      c.writeCalls++;
      return page.client.send(method, params, Contract.resolveDispatchPolicy(method));
    }
  });
  c.Modules.WritebackVerificationController = Verification;
  for (const name of ['mergeSaveStateOptions', 'saveStateSoon', 'runQueuedSaveState', 'flushQueuedSaveState',
    'getWritebackVerificationController', 'stageWritebackRecovery', 'checkRunWriteback', 'partitionOperationsForApply',
    'ensureReviewingBeforeWrite', 'buildReviewingBlockedApplyResult', 'applyTaskOperations']) vm.runInContext(extractFunction(source, name), c);
  c.updateSessionById('A', { runs: [{ id: 'writeback-run', runProjectId: P1, status: 'running', mode: 'auto', task: 'synthetic' }] });
  c.currentRunView = { recordId: 'writeback-run', sessionId: 'A', runProjectId: P1, runAccountScopeId: c.cachedAccountScopeId };
  c.state.requireReviewing = false;
  const operations = Writeback.buildSyncApplyOperations([{ type: 'write', path: 'main.tex', previousContent: 'before', content: 'after' }], page.project);
  return { ...f, page, operations, apply: () => c.applyTaskOperations(page.project, operations, { requireReviewing: false }),
    reload() { const records = [...f.records.values()]; c.state = Session.normalizePanelState({ sessions: records, activeSessionId: 'A' });
      c.currentRunView = null; c.writebackVerificationController = null; c.spaRouteGeneration++; },
    live: () => c.findRunRecord('writeback-run', 'A') };
}

test('real runtime write entry waits for queued save, scoped transaction and stored check readback before Page mutation', async t => {
  const f = await writebackRuntime(t); const result = await f.apply();
  assert.equal(result.ok, true); assert.equal(f.c.writeCalls, 1); assert.equal(f.page.textFiles.get('main.tex'), 'after');
  assert.ok(f.logs.stateWrites > 0); assert.equal(f.live().writebackCheck.purpose, 'writeback-revalidation');
  await f.page.cleanup();
});
for (const fault of ['nextWrite', 'nextSessionWrite', 'dropCheck']) test(`real runtime pre-write persistence ${fault} blocks every Page write`, async t => {
  const f = await writebackRuntime(t); f.fault[fault] = true;
  await assert.rejects(f.apply());
  assert.equal(f.c.writeCalls, 0); assert.equal(f.page.textFiles.get('main.tex'), 'before');
  await f.page.cleanup();
});
test('lost Page reply and holder rebuild retain a durably loaded read-only check without inventing Undo', async t => {
  const f = await writebackRuntime(t, { dropReply: true });
  const pending = f.apply();
  await until(() => f.page.textFiles.get('main.tex') === 'after', 'Page applied bytes');
  f.page.timeout('applyOperations'); const result = await pending; assert.equal(result.ok, false);
  await f.page.rebuild(); f.reload();
  const before = clone(f.live()); const writes = f.c.writeCalls, reads = f.c.pageMethods.length;
  await f.c.checkRunWriteback('writeback-run');
  assert.equal(f.live().writebackCheck.observation, 'matches'); assert.equal(f.live().saveConfirmedAt, undefined);
  assert.deepEqual(f.live().appliedOperations, before.appliedOperations); assert.deepEqual(f.live().undoOperations, before.undoOperations);
  assert.equal(f.c.writeCalls, writes); assert.ok(f.c.pageMethods.slice(reads).every(method => method === 'getProjectSnapshot'));
  const stored = [...f.records.values()].find(record => record.id === 'A');
  assert.equal(stored.runs.find(run => run.id === 'writeback-run').writebackCheck.observation, 'matches');
  await f.page.cleanup();
});
test('account changes while the real durable transaction waits cannot authorize a later write', async t => {
  const f = await writebackRuntime(t, { commitGate: 'review' });
  const pending = f.apply(); const rejected = assert.rejects(pending);
  await f.persistGate.entered; f.c.cachedAccountScopeId = 'other-account'; f.persistGate.release(); await rejected;
  assert.equal(f.c.writeCalls, 0); assert.equal(f.page.textFiles.get('main.tex'), 'before'); await f.page.cleanup();
});
