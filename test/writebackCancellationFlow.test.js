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
    require.resolve('../extension/src/content/writebackOrchestrator'), 'utf8'), { window, Function });
  const entered = deferred(), release = deferred(), calls = [];
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
    },
    async callPageBridge(method) {
      calls.push(method);
      if (method === 'waitForSaveState') { entered.resolve(); await release.promise; throw cancellation; }
      assert.equal(method, 'invalidateProjectSnapshot');
      return { ok: true };
    },
    resetContextProject() { calls.push('reset-context'); },
    async sendBackgroundNative({ method }) { calls.push(method); return { ok: true, result: { invalidated: true } }; }
  });
  const pending = api.applySyncChangesToOverleaf(project.files.map(file => ({ type: 'write', path: file.path,
    previousContent: file.content, content: 'after' })), project, { mode: 'auto', requireReviewing: false });
  await Promise.race([entered.promise, pending]);
  release.resolve();
  await assert.rejects(pending, error => error === cancellation);
  const outcome = cancellation.writebackOutcome;
  assert.equal(outcome.applied.applied[0], applied.applied[0]);
  assert.equal(outcome.applied.skipped[0], applied.skipped[0]);
  assert.equal(verification.state, 'unknown_timeout');
  assert.equal(verification.ok, false);
  assert.equal(outcome.saveVerification, verification);
  assert.deepEqual(calls, ['apply', 'undo', 'waitForSaveState', 'recovery', 'mirror.invalidate', 'reset-context', 'invalidateProjectSnapshot']);
  assert.equal(api.getPendingMirrorRefresh(), null);
  Object.assign(run, Settlement.applySettlementTransition(run, outcome.settlement), { status: 'cancelled' });
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
