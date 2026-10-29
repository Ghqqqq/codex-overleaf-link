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
    assert.deepEqual(calls, ['apply', 'undo', 'waitForSaveState', 'reset-context', 'invalidateProjectSnapshot', 'mirror.invalidate', 'recovery']);
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
  const reply = deferred(), events = [], settlements = [], cacheClears = [];
  const view = { runProjectId: 'example', sessionId: 's', recordId: 'r' };
  const run = { id: 'r', runProjectId: 'example', status: 'cancelled' };
  const cancellation = Object.assign(new Error('cancelled by the user'), { code: 'codex_cancelled' });
  const persistence = require('../extension/src/content/runSettlementPersistence').create({ writebackSettlement: Settlement,
    findRunRecord: () => run, getCurrentProjectId: () => 'example', getCurrentRunView: () => view });
  const api = window.CodexOverleafWritebackOrchestrator.create({ ...plan, tx, tr: key => key, getLocale: () => 'en',
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
    sendBackgroundNative: () => reply.promise,
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
  reply.resolve({ ok: true, result: { invalidated: true } });
  await advance(20000);
  assert.deepEqual(settlements, ['failed']);
  assert.equal(events.length, 1);
  assert.equal(run.settlement.evidence.mirrored, 'failed');
  assert.equal(timers.size, 0);
});
