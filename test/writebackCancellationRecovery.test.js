'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const load = file => require(path.join(repo, file));
const Client = load('extension/src/content/pageBridgeClient');
const Contract = load('extension/src/shared/pageRpcContract');
const Broker = load('extension/src/content/assetTransferBroker');
const Journal = load('extension/src/page/writebackReceiptJournal');
const Router = load('extension/src/page/writebackRouter');
const Editor = load('extension/src/page/overleafEditor');
const StaleGuard = load('extension/src/shared/staleGuard');
const WriteGuard = load('extension/src/page/writeGuard');
const ProjectFiles = load('extension/src/shared/projectFiles');
const Governance = load('extension/src/shared/governanceRules');
const Controller = load('extension/src/content/writebackController');
const Plan = load('extension/src/content/writebackPlan');
const Settlement = load('extension/src/shared/writebackSettlement');
const Undo = load('extension/src/shared/undoOperations');
const SessionState = load('extension/src/shared/sessionState');
const StorageDb = load('extension/src/shared/storageDb');
const Intent = load('extension/src/shared/writebackIntent');
const { extractFunction } = load('test/_helpers/extractFunction');
const runtimeSource = fs.readFileSync(path.join(repo, 'extension/src/content/contentRuntime.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(repo, 'extension/src/content/writebackOrchestrator.js'), 'utf8');
const noFetch = async () => { throw new Error('Network is disabled in this fixture'); };
const clone = value => JSON.parse(JSON.stringify(value));
const tx = english => english, tr = key => key;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture wait expired: ' + label); await tick(); }
}

function harness({ dropApply = false, cancelAfterBroker = false, partial = false } = {}) {
  const projectId = 'project-a';
  const files = new Map([['main.tex', 'before'], ['other.tex', partial ? 'collaborator text' : 'before']]);
  const project = { id: projectId, files: [...files.keys()].map(path => ({ path, kind: 'text', content: 'before' })) };
  const changes = (partial ? ['main.tex', 'other.tex'] : ['main.tex'])
    .map(path => ({ type: 'write', path, previousContent: 'before', content: 'after' }));
  let activePath = 'main.tex', pageSequence = 0, dispatches = 0, requests = 0, timerId = 0, journalExecutions = 0;
  let brokerReturned = false, undoCalls = 0, stageCalls = 0, appliedReports = 0, persisted = null;
  const events = [], messages = [], replies = [], errors = [], listeners = new Set(), timers = new Map(), work = [];
  const record = { id: 'run-a', runProjectId: projectId, status: 'running', mode: 'auto', task: 'synthetic task' };
  const state = { mode: 'auto', requireReviewing: false, autoRecompile: false, activeSessionId: 'session-a',
    sessions: [{ id: 'session-a', accountScopeId: 'account-a', runs: [record], history: [] }], runs: [record] };
  const view = { recordId: record.id, sessionId: 'session-a', runProjectId: projectId,
    executionSnapshot: { requireReviewing: false } };
  const getAppliedEntries = value => Array.isArray(value?.applied) ? value.applied : [];
  const getSkippedEntries = value => Array.isArray(value?.skipped) ? value.skipped : [];
  const flush = async () => { persisted = StorageDb.buildSessionRecord({ ...state.sessions[0], projectId }, { preserveRunActionPayload: true }); };
  const runtime = vm.createContext({
    console, fetch: noFetch, crypto: { randomUUID: crypto.randomUUID },
    state, currentRunView: view, cachedAccountScopeId: 'account-a', runCancellationRequested: false,
    spaRouteGeneration: 0, trackedChangeInFlight: new Map(), updateIdleClient: null,
    renderRunHistory() {}, showPluginToast() {},
    runCancellationController: new AbortController(), panel: { dataset: {} },
    getCurrentProjectId: () => projectId, findRunRecord: (id, sid) => id === record.id && sid === view.sessionId ? record : null,
    nativeChannel: { getActiveRequestId: () => 'synthetic-native-request' }, setRunning() {},
    appendRunEvent: event => events.push(event), refreshRunCardControls() {}, tr, tx,
    formatOperationType: value => value, getAppliedEntries, getSkippedEntries,
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    buildUndoCheckpoint: Undo.buildUndoCheckpoint, buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint,
    Modules: { UndoOperations: Undo, SessionState, WritebackIntent: Intent,
      StorageDb: { getRecord: async () => persisted } },
    writebackController: Controller, flushQueuedSaveState: flush
  });
  for (const name of ['recoveryOwner', 'stageWritebackRecovery', 'settleWritebackRecovery', 'recordUndoFromApply', 'cancelActiveRun']) {
    vm.runInContext(extractFunction(runtimeSource, name), runtime, { filename: 'contentRuntime.' + name + '.js' });
  }

  const doc = { toString: () => files.get(activePath), get length() { return files.get(activePath).length; } };
  const editorView = { state: { doc }, dispatch({ changes }) {
    dispatches++;
    let text = files.get(activePath);
    for (const change of (Array.isArray(changes) ? changes : [changes]).slice().sort((a, b) => b.from - a.from))
      text = text.slice(0, change.from) + change.insert + text.slice(change.to);
    files.set(activePath, text);
  } };
  const adapter = Editor.create({ getCodeMirrorEditorView: () => editorView,
    getCodeMirrorDocText: v => v.state.doc.toString(), getCodeMirrorDocLength: v => v.state.doc.length,
    normalizeTextPatches: patches => ({ ok: true, patches: Controller.normalizeTextPatches(patches) }) });
  const router = Router.create({ ...adapter, writebackOpenSettleMs: 0,
    readWriteCancellationSequence: () => pageSequence,
    getActiveEditorIdentity: () => ({ type: 'codemirror-view', doc }), activeEditorIdentityChanged: () => true,
    ensureEditing: async () => ({ ok: true }), normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    treeOperations: { getProjectId: () => projectId, getActiveFilePath: () => activePath,
      openFileByPath: async file => { activePath = file; return { ok: true, method: 'fixture-navigation' }; } },
    window: { _ide: { project: { _id: projectId } }, CodexOverleafStaleGuard: StaleGuard,
      CodexOverleafWriteGuard: WriteGuard, fetch: noFetch, setTimeout, clearTimeout }
  });
  const journal = Journal.create({ getProjectId: () => projectId,
    prepareEditor: async () => { throw new Error('No Undo dispatch is expected'); },
    applyOperations: async (ops, params) => { journalExecutions++; return router.applyOperations(ops, params); }
  });
  const pageWindow = {
    location: { origin: 'https://page-fixture.invalid' }, fetch: noFetch,
    addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn),
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), queueMicrotask,
    postMessage(message) {
      messages.push(clone(message));
      // Browser postMessage is task-queued. Cancellation microtasks must run
      // before the later Page reply, even when its receipt already exists.
      const task = new Promise(resolve => setImmediate(resolve)).then(async () => {
        let result;
        if (message.method === 'applyOperations') result = await journal.apply({ ...message.params, writebackRequestId: message.id });
        else if (message.method === 'getWritebackReceipt') result = journal.get(message.params);
        else if (message.method === 'cancelActiveWrite') result = { ok: true, cancelled: true, sequence: ++pageSequence };
        else if (message.method === 'waitForSaveState') {
          assert.ok(brokerReturned && undoCalls === 1, 'save verification occurs only after real Undo recording');
          result = { ok: true, state: 'verified_saved' };
        } else if (message.method === 'invalidateProjectSnapshot') result = { ok: true };
        else if (message.method === 'getProjectSnapshot') result = { id: projectId,
          files: [...files].map(([path, content]) => ({ path, content, kind: 'text', source: 'overleaf-zip' })),
          capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip', skipped: [] } };
        else throw new Error('Unexpected Page request: ' + message.method);
        if (dropApply && message.method === 'applyOperations') { replies.push({ method: message.method, dropped: true }); return; }
        await tick();
        replies.push({ method: message.method, id: message.id, listenerCount: listeners.size, result: clone(result) });
        for (const listener of [...listeners]) listener({ source: pageWindow, origin: pageWindow.location.origin,
          data: { source: 'codex-overleaf/page', pageBridgeVersion: '2.5.0', pageBridgeRevision: Contract.REVISION, id: message.id, result } });
      }).catch(error => { errors.push(error.message); });
      work.push(task);
    }
  };
  const client = Client.create({ window: pageWindow, document: {}, chromeApi: { runtime: { getURL: v => v } },
    crypto: { randomUUID: () => 'request-' + (++requests) }, contract: Contract,
    compatibility: { BUILD_TARGET_VERSION: '2.5.0' }, isCancellationRequested: () => runtime.runCancellationRequested });
  const callPageBridge = (method, params) => client.send(method, params, Contract.resolveDispatchPolicy(method));
  const sendBackgroundNative = async request => {
    assert.ok(['codex.cancel', 'mirror.confirmWriteback', 'mirror.sync', 'mirror.invalidate'].includes(request.method));
    events.push({ nativeMethod: request.method }); return { ok: true, result: { ok: true } };
  };
  runtime.callPageBridge = callPageBridge;
  runtime.sendBackgroundNative = sendBackgroundNative;
  // runtime's user cancel sets the flag. The Content client independently reads
  // it when starting a cancellable RPC; no cancellation error is stubbed here.
  const rawBroker = Broker.create({ callPageBridge, sendBackgroundNative });
  const assetTransferBroker = { async applyOperations(input) {
    const value = await rawBroker.applyOperations(input); brokerReturned = true;
    if (cancelAfterBroker) await runtime.cancelActiveRun();
    return value;
  } };
  const plan = Plan.create({ tx, tr, normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}),
    showPluginConfirm: async () => true, formatOperationFiles: () => '', getAppliedEntries, getSkippedEntries });
  const outer = vm.createContext({ window: { fetch: noFetch }, fetch: noFetch, console });
  vm.runInContext(orchestratorSource, outer, { filename: 'writebackOrchestrator.js' });
  const noop = () => {};
  const orchestrator = outer.window.CodexOverleafWritebackOrchestrator.create({
    compileAdapter: require('../extension/src/shared/compileAdapter'),
    ...plan, tr, tx, getLocale: () => 'en', getState: () => state, getCurrentRunView: () => view,
    getCurrentProjectId: () => projectId, getAssistantAnswerForCurrentRun: () => 'synthetic result', cleanFinalAnswer: x => x,
    appendRunEvent: event => events.push(event), appendRunRecordEvent: noop, appendChangeSummary: () => 'summary',
    appendCompletionReport: noop, appendOperationsPreview: noop, appendPartialWritebackWarning: noop,
    appendApplyResult: () => { appliedReports++; }, renderReadOnlyDiffReview: noop, showPluginConfirm: async () => true,
    ensureReviewingBeforeWrite: async () => ({ ok: true }),
    recordUndoFromApply(project, value) { undoCalls++; runtime.recordUndoFromApply(project, value); },
    stageWritebackRecovery(...args) { stageCalls++; return runtime.stageWritebackRecovery(...args); },
    settleWritebackRecovery: (...args) => runtime.settleWritebackRecovery(...args),
    assetTransferBroker, callPageBridge, sendBackgroundNative, writebackController: Controller, writebackSettlement: Settlement,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries,
    hasApplyResultEntries: value => getAppliedEntries(value).length + getSkippedEntries(value).length > 0,
    hasSkippedApplyOperations: values => values.some(value => getSkippedEntries(value).length),
    formatWritebackSkippedNextStep: () => 'review skipped', resetContextProject: noop, sanitizeRunProjectSnapshot: x => x,
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000
  });
  function receipt() {
    const message = messages.find(m => m.method === 'applyOperations');
    return message ? journal.get({ requestId: message.id, runProjectId: projectId }) : null;
  }
  return { runtime, record, files, messages, replies, events, errors, receipt,
    start() { return orchestrator.applySyncChangesToOverleaf(changes, project, { mode: 'auto', requireReviewing: false, autoRecompile: false }); },
    fireTimeout() { const timer = [...timers.values()].find(t => t.ms === Contract.resolveTimeoutMs('applyOperations'));
      assert.ok(timer, 'real PageBridgeClient initial write timeout is armed'); timer.fn(); },
    cancel: () => runtime.cancelActiveRun(),
    cancelRequests: () => client.cancelActiveRequests(),
    async cleanup() { await Promise.all(work); await orchestrator.getPendingMirrorRefresh(); assert.deepEqual(errors, []); },
    async observe(error) {
      await flush();
      const stored = persisted.runs.find(run => run.id === record.id);
      return { pageContent: files.get('main.tex'), otherContent: files.get('other.tex'), dispatches, journalExecutions,
        receiptState: receipt()?.state, receiptApplied: receipt()?.result?.applied?.length || 0,
        brokerReturned, undoCalls, stageCalls, appliedReports, cancelled: runtime.runCancellationRequested,
        error: error?.code || error?.message || '', undoCount: record.undoOperations?.length || 0,
        storageProjectionUndoCount: stored?.undoOperations?.length || 0, retryWriteback: Boolean(record.retryWriteback),
        receiptRequests: messages.filter(m => m.method === 'getWritebackReceipt').length,
        receiptReplies: replies.filter(m => m.method === 'getWritebackReceipt').length,
        receiptReplyListenerCounts: replies.filter(m => m.method === 'getWritebackReceipt').map(m => m.listenerCount),
        applyRequests: messages.filter(m => m.method === 'applyOperations').length,
        canUndo: Settlement.projectRunSettlement(record).canUndo };
    }
  };
}

for (const spec of [
  { id: 'normal-apply' },
  { id: 'lost-apply-receipt-recovered', dropApply: true },
  { id: 'cancel-after-timeout', dropApply: true, cancelAfterTimeout: true },
  { id: 'partial-write-cancel-after-timeout', dropApply: true, cancelAfterTimeout: true, partial: true },
  { id: 'cancel-after-broker-returned', cancelAfterBroker: true },
  { id: 'cancel-during-receipt-read', dropApply: true, cancelReceipt: true },
  { id: 'cancel-active-apply-before-timeout', dropApply: true, cancelActiveApply: true }
]) test(spec.id, { timeout: 15000 }, async () => {
  const h = harness(spec);
  const pending = h.start().then(value => ({ value }), error => ({ error }));
  try {
    await until(() => h.receipt()?.state === 'completed', 'real Page write and journal completion');
    assert.equal(h.files.get('main.tex'), 'after', 'Page write really landed before timeout/cancellation');
    assert.equal(h.receipt().result.applied.length, 1, 'Page journal independently holds the actual write result');
    if (spec.partial) assert.equal(h.receipt().result.skipped.length, 1, 'second conflicting file stays untouched');
    if (spec.cancelActiveApply) {
      await h.cancel(); h.cancelRequests();
    } else if (spec.dropApply) {
      h.fireTimeout();
      if (spec.cancelReceipt) {
        await until(() => h.messages.some(message => message.method === 'getWritebackReceipt'), 'receipt request dispatch');
        assert.equal(h.replies.some(reply => reply.method === 'getWritebackReceipt'), false);
        await h.cancel(); h.cancelRequests();
      }
      if (spec.cancelAfterTimeout) await h.cancel();
    }
    const result = await pending;
    await h.cleanup();
    const actual = await h.observe(result.error);
    const expected = { undoCount: 1, storageProjectionUndoCount: 1, applyRequests: 1, pageContent: 'after' };

    assert.equal(actual.pageContent, expected.pageContent);
    assert.equal(actual.applyRequests, 1, 'no write replay');
    if (spec.cancelAfterTimeout || spec.cancelReceipt || spec.cancelActiveApply) {
      assert.equal(actual.error, 'codex_cancelled');
      assert.equal(actual.receiptRequests, 1);
      assert.equal(actual.receiptReplies, 1, 'settlement consumes the original Page receipt after cancellation');
    } else if (spec.cancelAfterBroker) assert.equal(actual.error, 'codex_cancelled');
    else assert.equal(actual.error, '');
    assert.equal(actual.undoCount, 1, 'a Page-confirmed write must leave an actionable Undo checkpoint');
    assert.equal(actual.storageProjectionUndoCount, 1, 'the real session storage projection must retain recovery material');
  } finally { await h.cleanup(); }
});


test('cancelled run dispatches no new write', async () => {
  const h = harness();
  h.runtime.runCancellationRequested = true;
  await assert.rejects(h.start(), error => error.code === 'codex_cancelled' && error.changedDocument === false);
  assert.equal(h.files.get('main.tex'), 'before');
  assert.equal(h.messages.some(message => message.method === 'applyOperations'), false);
  await h.cleanup();
});
