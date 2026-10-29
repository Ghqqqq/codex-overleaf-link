'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Router = require('../extension/src/page/writebackRouter');
const StaleGuard = require('../extension/src/shared/staleGuard');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ beforeBatch, write } = {}) {
  let sequence = 0;
  const files = new Map(), calls = [], receipts = [];
  const router = Router.create({
    window: { CodexOverleafStaleGuard: StaleGuard },
    treeOperations: { getProjectId: () => 'example' },
    readWriteCancellationSequence: () => sequence,
    async beginTextCreateBatch(operations, options) {
      await beforeBatch?.(options);
      return { targets: new Set(operations.map(op => op.path)), pending: new Map(), blocked: new Set() };
    },
    async createTextFile(operation, options) {
      assert.equal(options.isCurrent(), true, 'a mutation must still own its project and cancellation sequence');
      calls.push(operation.path);
      files.set(operation.path, operation.content);
      if (write) return write(operation, options);
      return { ok: true, changedDocument: true, verified: true, verification: 'overleaf-zip' };
    }
  });
  return {
    files, calls, receipts,
    cancel() { sequence += 1; },
    apply(operations) {
      return router.applyOperations(operations, { runProjectId: 'example', baseFiles: [],
        onOperationResult: entry => receipts.push(entry) });
    }
  };
}

const operations = ['first.tex', 'second.tex', 'third.tex'].map(path => ({ type: 'create', path, content: path }));

test('cancellation during preflight prevents every mutation and the next request still runs', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({ beforeBatch: async () => { entered.resolve(); await release.promise; } });
  const pending = h.apply(operations);
  try {
    await Promise.race([entered.promise, pending]);
    assert.equal(h.calls.length, 0);
    h.cancel();
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 3);
  assert.ok(result.skipped.every(entry => entry.result.code === 'codex_cancelled'
    && entry.result.failure.changedDocument === false));
  assert.equal(h.files.size, 0);
  const next = await h.apply(operations);
  assert.equal(next.ok, true);
  assert.equal(next.applied.length, 3);
});

test('cancellation keeps the saved first file and leaves the rest untouched', async () => {
  const entered = deferred(), release = deferred();
  const operationResult = { ok: true, changedDocument: true, verified: true, verification: 'overleaf-zip',
      saveReceipt: { source: 'overleaf-zip', path: 'first.tex', sha256: 'a'.repeat(64) } };
  const h = harness({ write: async () => { entered.resolve(); await release.promise; return operationResult; } });
  const pending = h.apply(operations);
  try {
    await Promise.race([entered.promise, pending]);
    assert.deepEqual(h.calls, ['first.tex']);
    assert.equal(h.files.get('first.tex'), 'first.tex');
    h.cancel();
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.ok, false);
  const actual = result.applied[0];
  assert.equal(actual.operation.path, 'first.tex');
  assert.equal(actual.result, operationResult, 'do not replace real writeback evidence with a generic cancel result');
  const tail = result.skipped.filter(entry => entry.operation.path !== 'first.tex');
  assert.deepEqual(tail.map(entry => entry.operation.path), ['second.tex', 'third.tex']);
  assert.ok(tail.every(entry => entry.result.code === 'codex_cancelled'
    && entry.result.failure.changedDocument === false));
  assert.deepEqual(h.calls, ['first.tex']);
  assert.equal(h.files.has('second.tex'), false);
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].result, operationResult);
});

test('cancellation during editor navigation leaves the target and remaining files untouched', async t => {
  const entered = deferred(), release = deferred();
  const Editor = require('../extension/src/page/overleafEditor');
  const Guard = require('../extension/src/page/writeGuard');
  let sequence = 0, clock = 1000, active = 'other.tex';
  const files = new Map([['other.tex', 'other'], ['main.tex', 'before'], ['second.tex', 'second']]);
  const baseFiles = [...files].map(([path, content]) => ({ path, content }));
  const views = new Map([...files].map(([path]) => [path, { state: { doc: {
    toString: () => files.get(path), get length() { return files.get(path).length; }
  } }, dispatch({ changes }) { files.set(path, changes.insert); writes.push(path); } }]));
  const writes = [];
  t.mock.method(Date, 'now', () => clock);
  const adapter = Editor.create({ getCodeMirrorEditorView: () => views.get(active),
    getCodeMirrorDocText: view => view.state.doc.toString(), getCodeMirrorDocLength: view => view.state.doc.length });
  const router = Router.create({ ...adapter,
    window: { _ide: { project: { _id: 'example' } }, CodexOverleafStaleGuard: StaleGuard, CodexOverleafWriteGuard: Guard },
    readWriteCancellationSequence: () => sequence, writebackOpenSettleMs: 0,
    delay: async ms => { clock += ms; },
    getActiveEditorIdentity: () => ({ doc: views.get(active).state.doc }),
    activeEditorIdentityChanged: previous => previous?.doc !== views.get(active).state.doc,
    ensureEditing: async () => ({ ok: true }), getReviewingState: () => ({ editing: true }),
    isEditingConfirmedForNoTraceUndo: state => state.editing === true,
    treeOperations: { getProjectId: () => 'example', getActiveFilePath: () => active,
      projectPathExists: path => files.has(path), async openFileByPath(path) {
        active = path;
        entered.resolve();
        await release.promise;
        return { ok: true };
      } }
  });
  const edits = ['main.tex', 'second.tex'].map(path => ({ type: 'edit', path, replaceAll: 'after' }));
  const pending = router.applyOperations(edits, { runProjectId: 'example', requireEditing: true, baseFiles });
  try {
    await Promise.race([entered.promise, pending]);
    sequence += 1;
  } finally { release.resolve(); }
  const result = await pending;
  assert.deepEqual(writes, []);
  assert.deepEqual([...files], baseFiles.map(file => [file.path, file.content]));
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.skipped.map(entry => entry.operation.path), ['main.tex', 'second.tex']);
  assert.ok(result.skipped.every(entry => entry.result.code === 'codex_cancelled'
    && entry.result.failure.changedDocument === false));
});

test('cancelling save confirmation retains written results, save recovery and invalidates both caches', async () => {
  const Controller = require('../extension/src/content/writebackController');
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const Intent = require('../extension/src/shared/writebackIntent');
  const Session = require('../extension/src/shared/sessionState');
  const Files = require('../extension/src/shared/projectFiles');
  const tx = en => en;
  const plan = require('../extension/src/content/writebackPlan').create({ tx, tr: key => key,
    normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    GovernanceRules: require('../extension/src/shared/governanceRules'), getGovernanceRulesForCurrentProject: () => ({}),
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [] });
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function, setTimeout, clearTimeout });
  const entered = deferred(), release = deferred(), recoveryReady = deferred(), mirrorReply = deferred(), calls = [];
  const project = { id: 'example', files: [{ path: 'main.tex', content: 'before' }, { path: 'second.tex', content: 'second' }] };
  const view = { runProjectId: 'example', sessionId: 's', recordId: 'r' };
  const run = { id: 'r', runProjectId: 'example', mode: 'auto', status: 'running' };
  const cancellation = Object.assign(new Error('The run was cancelled by the user.'), { code: 'codex_cancelled' });
  let applied, verification;
  const api = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr: key => key, getLocale: () => 'en',
    getState: () => ({ mode: 'auto', autoRecompile: false }), getCurrentRunView: () => view, getCurrentProjectId: () => 'example',
    cleanFinalAnswer: value => value || '', getAssistantAnswerForCurrentRun: () => '',
    writebackController: Controller, writebackSettlement: Settlement,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries: value => value.skipped || [],
    hasApplyResultEntries: value => value.applied.length + value.skipped.length > 0,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), appendRunEvent() {}, appendRunRecordEvent() {},
    appendOperationsPreview() {}, appendApplyResult() {}, appendPartialWritebackWarning() {}, renderReadOnlyDiffReview() {},
    appendCompletionReport() { assert.fail('A cancelled write must not emit a completed writeback report.'); },
    assetTransferBroker: { async applyOperations({ operations }) {
      calls.push('apply');
      applied = { ok: false, applied: [{ operation: operations[0], result: { ok: true, verified: true, verifiedContent: 'after' } }],
        skipped: [{ operation: operations[1], result: { ok: false, code: 'codex_cancelled', changedDocument: false } }] };
      return applied;
    } },
    async recordUndoFromApply(_project, result) {
      calls.push('undo');
      run.appliedOperations = result.applied.map(entry => entry.operation);
      run.undoOperations = [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }];
    },
    async settleWritebackRecovery(result, original, saveVerification) {
      calls.push('recovery');
      verification = saveVerification;
      const check = await Controller.buildSaveCheck(result, original, { projectId: 'example', accountScopeId: 'a', sessionId: 's', runId: 'r' });
      run.saveCheck = Intent.normalizeSaveCheck(check);
      recoveryReady.resolve();
    },
    async callPageBridge(method) {
      calls.push(method);
      if (method === 'waitForSaveState') { entered.resolve(); await release.promise; throw cancellation; }
      assert.equal(method, 'invalidateProjectSnapshot');
      return { ok: true };
    },
    resetContextProject() { calls.push('reset-context'); },
    async sendBackgroundNative({ method }) { calls.push(method); await mirrorReply.promise; return { ok: true, result: { invalidated: true } }; },
    onMirrorRefreshSettled: require('../extension/src/content/runSettlementPersistence').create({
      writebackSettlement: Settlement, findRunRecord: () => run, getCurrentProjectId: () => 'example'
    }).settleMirrorRefresh
  });
  let finished = false;
  const pending = api.applySyncChangesToOverleaf(project.files.map(file => ({ type: 'write', path: file.path,
    previousContent: file.content, content: 'after' })), project, { mode: 'auto', requireReviewing: false })
    .then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
  await Promise.race([entered.promise, pending]);
  release.resolve();
  await recoveryReady.promise;
  await new Promise(resolve => setImmediate(resolve));
  const mirrorPending = api.getPendingMirrorRefresh();
  try {
    assert.equal(finished, true, 'cancellation must finish without a Native invalidation response');
    assert.equal((await pending).error, cancellation);
    assert.ok(mirrorPending, 'mirror reuse must still wait for the unanswered invalidation');
    assert.deepEqual(calls.slice(0, 5), ['apply', 'undo', 'waitForSaveState', 'reset-context', 'invalidateProjectSnapshot']);
    assert.deepEqual(calls.slice(5).sort(), ['mirror.invalidate', 'recovery']);
    assert.equal(cancellation.writebackOutcome.settlement.facts.evidence.mirrored, 'unknown');
    Object.assign(run, Settlement.applySettlementTransition(run, cancellation.writebackOutcome.settlement), { status: 'cancelled' });
  } finally {
    mirrorReply.resolve();
    await pending;
    await mirrorPending;
  }
  const outcome = cancellation.writebackOutcome;
  assert.equal(outcome.applied.applied[0], applied.applied[0]);
  assert.equal(outcome.applied.skipped[0], applied.skipped[0]);
  assert.equal(verification.state, 'unknown_timeout');
  assert.equal(verification.ok, false);
  assert.equal(outcome.saveVerification, verification);
  assert.equal(api.getPendingMirrorRefresh(), null);
  assert.equal(run.settlement.evidence.mirrored, 'not-attempted', 'the late acknowledgment settles the original cancelled run');
  const restored = Session.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId: 'example', runs: [run] }] }).sessions[0].runs[0];
  assert.equal(restored.appliedOperations.length, restored.undoOperations.length);
  assert.equal(restored.appliedOperations.length, 1);
  assert.equal(restored.saveCheck.files.length, 1);
  assert.equal(restored.saveCheck.files[0].path, 'main.tex');
  assert.equal(restored.saveCheck.files[0].sha256, require('node:crypto').createHash('sha256').update('after').digest('hex'));
  assert.equal(restored.settlement.documentEffect, 'changed');
  assert.notEqual(restored.settlement.evidence.saved, 'verified');
  assert.notEqual(restored.settlement.evidence.mirrored, 'complete');
});

test('a successful save reply after Stop retains the written and saved report evidence', async () => {
  const Controller = require('../extension/src/content/writebackController');
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const Transcript = require('../extension/src/shared/agentTranscript');
  const Contract = require('../extension/src/shared/pageRpcContract');
  const compatibility = require('../extension/src/shared/compatibility');
  const entered = deferred(), saveReply = deferred(), listeners = new Set(), calls = [];
  let cancelled = false, sequence = 0, verification;
  const win = { location: { origin: 'https://fixture.invalid' }, setTimeout, clearTimeout,
    addEventListener: (_name, listener) => listeners.add(listener), removeEventListener: (_name, listener) => listeners.delete(listener),
    postMessage(request) {
      calls.push(request.method);
      assert.equal(request.method, 'waitForSaveState');
      entered.resolve();
      saveReply.promise.then(result => {
        for (const listener of [...listeners]) listener({ source: win, origin: win.location.origin,
          data: { source: 'codex-overleaf/page', id: request.id, pageBridgeVersion: compatibility.BUILD_TARGET_VERSION,
            pageBridgeRevision: Contract.REVISION, result } });
      });
    } };
  const page = require('../extension/src/content/pageBridgeClient').create({ window: win, compatibility, contract: Contract,
    crypto: { randomUUID: () => String(++sequence) }, isCancellationRequested: () => cancelled });
  const tx = en => en;
  const plan = require('../extension/src/content/writebackPlan').create({ tx, tr: key => key,
    normalizeSafeProjectPath: require('../extension/src/shared/projectFiles').normalizeSafeProjectPath,
    GovernanceRules: require('../extension/src/shared/governanceRules'), getGovernanceRulesForCurrentProject: () => ({}),
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [] });
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function, setTimeout, clearTimeout });
  const api = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr: key => key, getLocale: () => 'en',
    getState: () => ({ mode: 'auto', autoRecompile: false }),
    getCurrentRunView: () => ({ runProjectId: 'example', sessionId: 's', recordId: 'r' }), getCurrentProjectId: () => 'example',
    cleanFinalAnswer: value => value || '', getAssistantAnswerForCurrentRun: () => '',
    writebackController: Controller, writebackSettlement: Settlement, compileAdapter: require('../extension/src/shared/compileAdapter'),
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries: value => value.skipped || [],
    hasApplyResultEntries: value => value.applied.length > 0, hasSkippedApplyOperations: () => false,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), appendRunEvent() {}, appendRunRecordEvent() {},
    appendOperationsPreview() {}, appendApplyResult() {}, renderReadOnlyDiffReview() {}, appendCompletionReport() {},
    appendChangeSummary: () => '', recordUndoFromApply: async () => {},
    assetTransferBroker: { async applyOperations({ operations }) {
      return { ok: true, applied: operations.map(operation => ({ operation, result: { ok: true, verified: true, verifiedContent: 'after' } })), skipped: [] };
    } },
    settleWritebackRecovery: async (_applied, _project, value) => { verification = value; },
    callPageBridge: (method, params) => page.send(method, params, Contract.resolveDispatchPolicy(method)),
    async sendBackgroundNative({ method, params }) {
      calls.push(method);
      assert.equal(method, 'mirror.confirmWriteback');
      return { ok: true, result: { ok: true, confirmed: params.expectedFiles.map(file => ({ path: file.path, hash: file.sha256 })) } };
    }
  });
  const pending = api.applySyncChangesToOverleaf([{ type: 'write', path: 'main.tex', previousContent: 'before', content: 'after' }],
    { id: 'example', files: [{ path: 'main.tex', content: 'before' }] }, { mode: 'auto', requireReviewing: false, autoRecompile: false });
  await Promise.race([entered.promise, pending]);
  cancelled = true;
  saveReply.resolve({ ok: true, state: 'verified_saved' });
  const outcome = await pending;
  await api.getPendingMirrorRefresh();
  assert.equal(outcome.applied.applied.length, 1);
  assert.equal(outcome.applied.skipped.length, 0);
  assert.equal(outcome.operations.length, 1);
  assert.equal(outcome.saveVerification, verification);
  assert.equal(verification.state, 'verified_saved');
  assert.equal(outcome.settlement.facts.evidence.saved, 'verified');
  assert.equal(calls.includes('mirror.invalidate'), false);
  const report = Transcript.buildHumanCompletionReport({ ...outcome, conclusionKey: 'cancelled', status: 'cancelled',
    applyResults: [outcome.applied], includeWriteResult: true, undoCount: 1 });
  const meta = key => report.structured.meta.find(row => row.key === key)?.value;
  assert.deepEqual(meta('writeResult').match(/\d+/g).map(Number), [1, 0]);
  assert.equal(report.structured.meta.some(row => row.key === 'unchangedReason'), false);
  const knownSaved = Transcript.buildHumanCompletionReport({ saveVerification: { state: 'verified_saved' } });
  assert.equal(meta('saveState'), knownSaved.structured.meta.find(row => row.key === 'saveState').value);
});

test('retry mirror work retains an unanswered cancellation barrier and ignores its obsolete settlement', async () => {
  const Controller = require('../extension/src/content/writebackController');
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const tx = en => en;
  const plan = require('../extension/src/content/writebackPlan').create({ tx, tr: key => key,
    normalizeSafeProjectPath: require('../extension/src/shared/projectFiles').normalizeSafeProjectPath,
    GovernanceRules: require('../extension/src/shared/governanceRules'), getGovernanceRulesForCurrentProject: () => ({}),
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [] });
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function, setTimeout, clearTimeout });
  const invalidationReply = deferred(), confirmReply = deferred(), confirmStarted = deferred(), newerSettled = deferred();
  const view = { runProjectId: 'example', sessionId: 's', recordId: 'r' };
  const run = { id: 'r', runProjectId: 'example' }, settlements = [];
  const persistence = require('../extension/src/content/runSettlementPersistence').create({ writebackSettlement: Settlement,
    findRunRecord: () => run, getCurrentProjectId: () => 'example', getCurrentRunView: () => view });
  let attempt = 0;
  const api = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr: key => key, getLocale: () => 'en',
    getState: () => ({ mode: 'auto', autoRecompile: false }), getCurrentRunView: () => view, getCurrentProjectId: () => 'example',
    cleanFinalAnswer: value => value || '', getAssistantAnswerForCurrentRun: () => '',
    writebackController: Controller, writebackSettlement: Settlement, compileAdapter: require('../extension/src/shared/compileAdapter'),
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries: value => value.skipped || [],
    hasApplyResultEntries: value => value.applied.length > 0, hasSkippedApplyOperations: () => false,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), appendRunEvent() {}, appendRunRecordEvent() {},
    appendOperationsPreview() {}, appendApplyResult() {}, renderReadOnlyDiffReview() {}, appendCompletionReport() {},
    appendChangeSummary: () => '', recordUndoFromApply: async () => {}, settleWritebackRecovery: async () => {}, resetContextProject() {},
    assetTransferBroker: { async applyOperations({ operations }) {
      attempt += 1;
      return { ok: true, applied: operations.map(operation => ({ operation, result: { ok: true, verified: true, verifiedContent: 'after' } })), skipped: [] };
    } },
    async callPageBridge(method) {
      if (method === 'waitForSaveState') {
        if (attempt === 1) throw Object.assign(new Error('cancelled by the user'), { code: 'codex_cancelled' });
        return { ok: true, state: 'verified_saved' };
      }
      assert.equal(method, 'invalidateProjectSnapshot');
      return { ok: true };
    },
    async sendBackgroundNative({ method, params }) {
      if (method === 'mirror.invalidate') {
        await invalidationReply.promise;
        return { ok: true, result: { invalidated: true } };
      }
      assert.equal(method, 'mirror.confirmWriteback');
      confirmStarted.resolve();
      await confirmReply.promise;
      return { ok: true, result: { ok: true, confirmed: params.expectedFiles.map(file => ({ path: file.path, hash: file.sha256 })) } };
    },
    onMirrorRefreshSettled(result) {
      persistence.settleMirrorRefresh(result);
      settlements.push(result.state);
      if (result.state === 'complete') newerSettled.resolve();
    }
  });
  const change = path => ({ type: 'write', path, previousContent: 'before', content: 'after' });
  const project = { id: 'example', files: ['main.tex', 'second.tex'].map(path => ({ path, content: 'before' })) };
  let originalBarrier;
  try {
    await assert.rejects(api.applySyncChangesToOverleaf([change('main.tex')], project, { mode: 'auto', requireReviewing: false }), error => {
      persistence.applyToCurrentRun(error.writebackOutcome.settlement);
      return error.code === 'codex_cancelled';
    });
    originalBarrier = api.getPendingMirrorRefresh();
    assert.ok(originalBarrier);
    // Exercise the shared owner independently of the UI's retry admission wait.
    const retry = await api.applySyncChangesToOverleaf([change('second.tex')], project,
      { mode: 'auto', requireReviewing: false, autoRecompile: false, retryCreates: true });
    persistence.applyToCurrentRun(retry.settlement);
    await confirmStarted.promise;
    confirmReply.resolve();
    await newerSettled.promise;
    await new Promise(resolve => setImmediate(resolve));
    const combined = api.getPendingMirrorRefresh();
    assert.ok(combined, 'finishing the retry cannot drop the older outstanding invalidation');
    assert.notEqual(combined, originalBarrier);
    let freshRunPassed = false;
    const freshWait = combined.then(() => { freshRunPassed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(freshRunPassed, false);
    assert.equal(run.settlement.evidence.mirrored, 'complete');
    invalidationReply.resolve();
    await combined;
    await freshWait;
    assert.equal(run.settlement.evidence.mirrored, 'complete', 'the obsolete invalidation cannot settle the newer attempt');
    assert.deepEqual(settlements, ['complete']);
    assert.equal(api.getPendingMirrorRefresh(), null);
  } finally {
    invalidationReply.resolve();
    confirmReply.resolve();
    await originalBarrier;
    await api.getPendingMirrorRefresh();
  }
});

test('cancelled save recovery releases the mirror barrier on timeout and ignores a late invalidation reply', async () => {
  const Controller = require('../extension/src/content/writebackController');
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const tx = en => en;
  const plan = require('../extension/src/content/writebackPlan').create({ tx, tr: key => key,
    normalizeSafeProjectPath: require('../extension/src/shared/projectFiles').normalizeSafeProjectPath,
    GovernanceRules: require('../extension/src/shared/governanceRules'), getGovernanceRulesForCurrentProject: () => ({}),
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [] });
  const timers = new Map();
  let now = 0, timerId = 0;
  const window = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const reply = deferred(), fenceWrite = deferred(), events = [], settlements = [], cacheClears = [];
  let invalidationCalls = 0;
  let invalidationReply = reply.promise;
  const stored = new Map();
  const storage = { storage: { local: {
    async get() { return Object.fromEntries(stored); },
    async set(values) {
      await fenceWrite.promise;
      for (const [key, value] of Object.entries(values)) stored.set(key, value);
    },
    async remove(keys) { for (const key of keys) stored.delete(key); }
  } } };
  const Adapter = require('../extension/src/shared/scopedPersistenceBrowserAdapter');
  const mirrorFenceStore = {
    getMirrorReuseFences: scope => Adapter.getMirrorReuseFences(scope, storage),
    setMirrorReuseFence: (scope, generation) => Adapter.setMirrorReuseFence(scope, generation, storage),
    clearMirrorReuseFences: (scope, generations) => Adapter.clearMirrorReuseFences(scope, generations, storage)
  };
  const view = { runProjectId: 'example', sessionId: 's', recordId: 'r' };
  const run = { id: 'r', runProjectId: 'example', status: 'cancelled' };
  const cancellation = Object.assign(new Error('cancelled by the user'), { code: 'codex_cancelled' });
  const persistence = require('../extension/src/content/runSettlementPersistence').create({ writebackSettlement: Settlement,
    findRunRecord: () => run, getCurrentProjectId: () => 'example', getCurrentRunView: () => view });
  const api = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr: key => key, getLocale: () => 'en',
    mirrorFenceStore, getAccountScopeId: () => 'account-one',
    getState: () => ({ mode: 'auto', autoRecompile: false }), getCurrentRunView: () => view, getCurrentProjectId: () => 'example',
    cleanFinalAnswer: value => value || '', getAssistantAnswerForCurrentRun: () => '',
    writebackController: Controller, writebackSettlement: Settlement,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries: value => value.skipped || [],
    hasApplyResultEntries: value => value.applied.length > 0,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), appendRunEvent() {},
    appendRunRecordEvent(recordId, event) { events.push({ recordId, ...event }); },
    appendOperationsPreview() {}, appendApplyResult() {}, renderReadOnlyDiffReview() {},
    assetTransferBroker: { async applyOperations({ operations }) {
      return { ok: true, applied: operations.map(operation => ({ operation, result: { ok: true, verified: true, verifiedContent: 'after' } })), skipped: [] };
    } },
    async recordUndoFromApply(_project, result) {
      run.appliedOperations = result.applied.map(entry => entry.operation);
      run.undoOperations = [{ type: 'edit', path: 'main.tex', replaceAll: 'before' }];
    },
    settleWritebackRecovery: async () => {},
    resetContextProject() { cacheClears.push('context'); },
    async callPageBridge(method) {
      if (method === 'waitForSaveState') throw cancellation;
      assert.equal(method, 'invalidateProjectSnapshot');
      cacheClears.push('page');
      return { ok: true };
    },
    sendBackgroundNative: () => { invalidationCalls++; return invalidationReply; },
    onMirrorRefreshSettled(result) { settlements.push(result.state); persistence.settleMirrorRefresh(result); }
  });
  await assert.rejects(api.applySyncChangesToOverleaf([{ type: 'write', path: 'main.tex', previousContent: 'before', content: 'after' }],
    { id: 'example', files: [{ path: 'main.tex', content: 'before' }] }, { mode: 'auto', requireReviewing: false }), error => {
    assert.equal(error, cancellation);
    persistence.applyToCurrentRun(error.writebackOutcome.settlement);
    return true;
  });
  assert.deepEqual(cacheClears, ['context', 'page']);
  const pending = api.getPendingMirrorRefresh();
  assert.equal(invalidationCalls, 0, 'publish the durable fence before dispatching Native invalidation');
  fenceWrite.resolve();
  await advance(0);
  assert.equal(invalidationCalls, 1);
  const waitingFence = api.getMirrorReuseFence('example');
  assert.ok(waitingFence, 'cancellation must fence reuse while Native is still unanswered');
  assert.equal(waitingFence.generations.length, 1);
  assert.ok(await newPage().refreshMirrorReuseFence('example'), 'a second tab cannot reuse the mirror during the wait');
  assert.ok(await newPage().refreshMirrorReuseFence('example'), 'a refreshed page observes the pending invalidation fence');
  let admitted = false;
  const admission = pending.then(() => { admitted = true; });
  await advance(19999);
  assert.equal(admitted, false);
  assert.equal(run.settlement.evidence.mirrored, 'unknown');
  await advance(1);
  assert.equal(admitted, true, 'dependent work must not wait forever for a lost Native reply');
  assert.equal(await pending, 'failed');
  await admission;
  assert.equal(api.getPendingMirrorRefresh(), null);
  assert.equal(run.settlement.evidence.mirrored, 'failed');
  assert.equal(cancellation.writebackOutcome.settlement.facts.evidence.mirrored, 'failed');
  assert.equal(events.length, 1);
  assert.equal(events[0].recordId, 'r');
  assert.equal(events[0].status, 'warning');
  assert.equal(run.undoOperations[0].replaceAll, 'before');
  const firstFence = api.getMirrorReuseFence('example');
  assert.equal(firstFence, waitingFence, 'timeout retains the pending generation without creating a duplicate');
  assert.ok(firstFence, 'failed invalidation must fence reuse even when Retry did not run Codex');
  assert.equal(api.getMirrorReuseFence('other-project'), null);
  function newPage(account = 'account-one') {
    const reloaded = {};
    require('node:vm').runInNewContext(require('node:fs').readFileSync(
      require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window: reloaded, Function, setTimeout, clearTimeout });
    return reloaded.CodexOverleafWritebackOrchestrator.create({ mirrorFenceStore,
      getAccountScopeId: () => account, getCurrentProjectId: () => 'example' });
  }
  const reloaded = newPage(), secondTab = newPage();
  assert.ok(await reloaded.refreshMirrorReuseFence('example'), 'the fence survives a fresh page runtime');
  assert.ok(await secondTab.refreshMirrorReuseFence('example'), 'another tab of the same project observes the fence');
  assert.equal(await newPage('account-two').refreshMirrorReuseFence('example'), null);
  assert.equal(await reloaded.refreshMirrorReuseFence('other-project'), null);
  reply.resolve({ ok: true, result: { invalidated: true } });
  await advance(20000);
  assert.deepEqual(settlements, ['failed']);
  assert.equal(events.length, 1);
  assert.equal(run.settlement.evidence.mirrored, 'failed');
  assert.equal(timers.size, 0);
  assert.equal(api.getMirrorReuseFence('example'), firstFence, 'a late invalidation reply cannot clear the fence');

  const fullProject = { id: 'example', files: [{ path: 'main.tex', content: 'after' }],
    capabilities: { fullProjectSnapshot: true, contentComplete: true } };
  const syncReply = deferred();
  let syncCalls = 0;
  const options = { fence: firstFence, assertCurrent() {}, async sendNative({ method, params }) {
    if (method === 'mirror.status') return { ok: true, result: { exists: true, dirty: false } };
    assert.equal(method, 'mirror.sync');
    assert.equal(params.projectId, 'example');
    assert.equal(params.project.files[0].content, 'after');
    syncCalls += 1;
    return syncReply.promise;
  } };
  assert.equal(await api.syncFencedMirror('example', { ...fullProject, capabilities: { fullProjectSnapshot: false } }, options), false);
  assert.equal(syncCalls, 0, 'a partial snapshot cannot clear the fence');
  const oldSync = api.syncFencedMirror('example', fullProject, options);
  assert.equal(await api.syncFencedMirror('example', fullProject, options), false);
  assert.equal(syncCalls, 1, 'the extra full sync is attempted at most once per fence');
  invalidationReply = Promise.resolve({ ok: false, error: { code: 'mirror_invalidation_failed' } });
  await assert.rejects(api.applySyncChangesToOverleaf([{ type: 'write', path: 'main.tex', content: 'after' }],
    fullProject, { mode: 'auto', requireReviewing: false, retryCreates: true }), { code: 'codex_cancelled' });
  await api.getPendingMirrorRefresh();
  const newerFence = api.getMirrorReuseFence('example');
  assert.ok(newerFence);
  assert.notEqual(newerFence, firstFence, 'rejected invalidation also installs a new project fence');
  syncReply.resolve({ ok: true });
  assert.equal(await oldSync, false);
  assert.equal(api.getMirrorReuseFence('example'), newerFence, 'a sync started before the failure cannot clear its fence');
  assert.equal(await api.syncFencedMirror('example', fullProject, { ...options, fence: newerFence }), true);
  assert.equal(syncCalls, 2);
  assert.equal(api.getMirrorReuseFence('example'), null, 'a later successful full sync restores reuse');
  assert.equal(stored.size, 0);
  assert.equal(await reloaded.refreshMirrorReuseFence('example'), null, 'an existing peer observes durable clearing');
  assert.equal(await secondTab.refreshMirrorReuseFence('example'), null);
  assert.equal(await newPage().refreshMirrorReuseFence('example'), null, 'clearing also survives reload');

  // An answered invalidation needs no extra full sync, but may only remove
  // the fence created for that attempt, never another tab's failure evidence.
  invalidationReply = Promise.resolve({ ok: true, result: { invalidated: true } });
  await assert.rejects(api.applySyncChangesToOverleaf([{ type: 'write', path: 'main.tex', content: 'after' }],
    fullProject, { mode: 'auto', requireReviewing: false, retryCreates: true }), { code: 'codex_cancelled' });
  await api.getPendingMirrorRefresh();
  assert.equal(await api.refreshMirrorReuseFence('example'), null);
  assert.equal(stored.size, 0, 'confirmed invalidation retires only its pending fence without a full sync');

  const scope = { accountScopeId: 'account-one', projectId: 'example' };
  await mirrorFenceStore.setMirrorReuseFence(scope, 'older-failure');
  await api.refreshMirrorReuseFence('example');
  const acknowledged = deferred();
  invalidationReply = acknowledged.promise;
  await assert.rejects(api.applySyncChangesToOverleaf([{ type: 'write', path: 'main.tex', content: 'after' }],
    fullProject, { mode: 'auto', requireReviewing: false, retryCreates: true }), { code: 'codex_cancelled' });
  const confirming = api.getPendingMirrorRefresh();
  await advance(0);
  await mirrorFenceStore.setMirrorReuseFence(scope, 'newer-failure');
  acknowledged.resolve({ ok: true, result: { invalidated: true } });
  await confirming;
  const peerFence = await newPage().refreshMirrorReuseFence('example');
  assert.deepEqual(Array.from(peerFence.generations), ['newer-failure', 'older-failure']);
  assert.equal(stored.size, 2, 'an old success cannot erase another invalidation generation');
});

test('Undo invalidation failure fences a clean mirror across tabs and timeout keeps its original account', async t => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const Mirror = require('../native-host/src/mirrorWorkspace');
  const rootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'undo-mirror-fence-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const projectId = 'undo-project', accountScopeId = 'undo-account';
  const project = { id: projectId, capabilities: { fullProjectSnapshot: true }, files: [
    { path: 'active.tex', content: 'Unchanged active document' },
    { path: 'undone.tex', content: 'After the model edit' }
  ] };
  await Mirror.syncOverleafToMirror({ projectId, project, rootDir });
  const stored = new Map(), timers = new Map(), events = [], pageCalls = [], nativeCalls = [];
  let clock = 0, timerId = 0, contextResets = 0;
  let currentProject = projectId, currentAccount = accountScopeId;
  let nativeReply = Promise.resolve({ ok: false, error: { code: 'project_locked', message: 'Mirror is busy.' } });
  const chromeApi = { storage: { local: {
    async get() { return Object.fromEntries(stored); },
    async set(values) { for (const [key, value] of Object.entries(values)) stored.set(key, value); },
    async remove(keys) { for (const key of keys) stored.delete(key); }
  } } };
  const Adapter = require('../extension/src/shared/scopedPersistenceBrowserAdapter');
  const mirrorFenceStore = {
    getMirrorReuseFences: scope => Adapter.getMirrorReuseFences(scope, chromeApi),
    setMirrorReuseFence: (scope, generation) => Adapter.setMirrorReuseFence(scope, generation, chromeApi),
    clearMirrorReuseFences: (scope, generations) => Adapter.clearMirrorReuseFences(scope, generations, chromeApi)
  };
  function page(deps = {}) {
    const window = {};
    vm.runInNewContext(fs.readFileSync(require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), {
      window, Function,
      setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, at: clock + ms }); return id; },
      clearTimeout(id) { timers.delete(id); }
    });
    return window.CodexOverleafWritebackOrchestrator.create({ mirrorFenceStore, tx: en => en,
      getCurrentProjectId: () => projectId, getAccountScopeId: () => accountScopeId, ...deps });
  }
  const api = page({ getCurrentProjectId: () => currentProject, getAccountScopeId: () => currentAccount,
    resetContextProject() { contextResets++; },
    async callPageBridge(method, params) { pageCalls.push({ method, params }); return { ok: true }; },
    sendBackgroundNative(payload) { nativeCalls.push(payload); return nativeReply; },
    appendRunRecordEvent(recordId, event) { events.push({ recordId, ...event }); }
  });
  const result = { ok: true, changedDocument: true,
    applied: [{ operation: { path: 'undone.tex' }, result: { verifiedContent: 'Before the model edit' } }] };
  const owner = { runAccountScopeId: accountScopeId, sessionId: 'undo-session' };
  assert.equal(await api.invalidateMirrorAfterUndo('undo-run', projectId, result, owner), 'failed');
  assert.equal(api.getPendingMirrorRefresh(), null);
  assert.equal(contextResets, 1);
  assert.equal(pageCalls[0].method, 'invalidateProjectSnapshot');
  assert.equal(pageCalls[0].params.runProjectId, projectId);
  assert.equal(events[0].recordId, 'undo-run');
  assert.equal(events[0].status, 'warning');
  const status = Mirror.getMirrorStatus(projectId, { rootDir });
  assert.equal(status.dirty, false, 'the rejected invalidation leaves a plausible but stale Native baseline');
  const peer = page();
  assert.ok(await peer.refreshMirrorReuseFence(projectId));
  const warmWindow = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/src/content/otWarmMirror'), 'utf8'), { window: warmWindow });
  const warm = warmWindow.CodexOverleafOtWarmMirror.create({
    getCurrentProjectId: () => projectId, getState: () => ({ mode: 'ask', experimentalOtByProject: {} }),
    getMirrorFreshness: async () => await peer.refreshMirrorReuseFence(projectId) ? null : status,
    mirrorHealth: require('../extension/src/content/mirrorHealth'),
    otWarmMirrorController: require('../extension/src/content/otWarmMirrorController'),
    normalizeSnapshotPath: value => value, buildSnapshotFileOverlays: snapshot => snapshot.files,
    async callPageBridge() { return { id: projectId, files: [project.files[0]] }; }
  });
  assert.equal((await warm.resolveWarmRunStart({ mode: 'ask' })).useExistingMirror, false);

  const reply = deferred();
  nativeReply = reply.promise;
  const pending = api.invalidateMirrorAfterUndo('later-undo', projectId, result, owner);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeCalls.at(-1).params.projectId, projectId);
  const waiting = await page().refreshMirrorReuseFence(projectId);
  assert.equal(waiting.generations.length, 2);
  currentProject = 'other-project'; currentAccount = 'other-account';
  clock += 20000;
  for (const [id, timer] of [...timers]) if (timer.at <= clock) {
    timers.delete(id); timer.callback();
  }
  assert.equal(await pending, 'failed');
  assert.equal(api.getPendingMirrorRefresh(), null);
  assert.equal(await api.refreshMirrorReuseFence(currentProject, currentAccount), null);
  assert.equal((await page().refreshMirrorReuseFence(projectId)).generations.length, 2);
  assert.equal(events.at(-1).recordId, 'later-undo');
  reply.resolve({ ok: true, result: { invalidated: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stored.size, 2, 'a late Undo acknowledgment cannot retire the timed-out fence');
  assert.equal(events.length, 2);
  assert.equal(result.applied[0].result.verifiedContent, 'Before the model edit');
});
