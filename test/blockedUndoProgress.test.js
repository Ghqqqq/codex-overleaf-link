'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Undo = require('../extension/src/shared/undoOperations');
const FailureReasons = require('../extension/src/shared/failureReasons');
const Scope = require('../extension/src/content/scopedPersistenceCoordinator');
const Sessions = require('../extension/src/content/sessionPersistence');
const Db = require('../extension/src/shared/storageDb');
const State = require('../extension/src/shared/sessionState');

const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const actionSource = ['applyTrackedChangeSettlement', 'advanceRunUndoProgress']
  .map(name => extractFunction(source, name)).join('\n');
const clone = value => structuredClone(value);
const scope = { accountScopeId: 'account-a', projectId: 'project-a' };
const nestedPath = 'qa/nested.tex';
const pngPath = 'qa.png';
function pendingRun() {
  const project = { files: [{ path: 'main.tex', content: 'before' }] };
  const appliedOperations = [
    { type: 'edit', path: 'main.tex', replaceAll: 'after', verifiedContent: 'after' },
    { type: 'create', path: nestedPath, content: 'nested text' },
    { type: 'binary-create', path: pngPath, sha256: 'a'.repeat(64) }
  ];
  const text = Undo.buildUndoCheckpoint(project, [appliedOperations[0]]);
  const created = Undo.buildCreatedFileUndoCheckpoint(project, appliedOperations);
  const run = { id: 'run-mixed', task: 'mixed undo', runProjectId: scope.projectId, mode: 'auto',
    status: 'completed', trackedChangeStatus: 'pending', undoStatus: 'ready', appliedOperations,
    executionSnapshot: { mode: 'auto', requireReviewing: true, source: 'submitted' },
    undoOperations: [...text.undoOperations, ...created.undoOperations],
    undoBaseFiles: [...text.undoBaseFiles, ...created.undoBaseFiles],
    undoExpectedFiles: clone(project.files),
    undoTrackedChanges: [{ id: 'owned-change', path: 'main.tex', key: 'native:main:owned-change', label: '' }],
    trackedChangeCaptures: [], events: [] };
  // The preliminary text-stage failure must be replaced by the final, file-scoped receipt.
  return Settlement.applySettlementTransition(run,
    Settlement.settleLegacyUndo({ run, status: 'partial', result: { ok: false } }));
}
function blocked(pathname = nestedPath, code = 'target_file_not_found') {
  return { ...(pathname ? { operation: { type: 'delete', path: pathname } } : {}), result: {
    ok: false, code, reason: 'The nested file could not be resolved.', changedDocument: false,
    failure: { code, stage: 'navigation', severity: 'blocked', terminalState: 'blocked',
      userMessage: 'The nested file could not be resolved.', retryable: true,
      nextAction: 'Expand the directory and retry Undo.',
      technicalMessage: 'The target row is unavailable under the collapsed directory.',
      evidence: { originalCode: code, lookup: 'full-path' } }
  } };
}
function mainReceipt(overrides = {}) {
  return { trackedChange: { path: 'main.tex', key: 'editor-undo:main.tex' }, result: {
    ok: true, method: 'overleaf-editor-undo', verified: true, verifiedContent: 'before', ...overrides
  } };
}
function deletionReceipt(run, pathname = pngPath, overrides = {}) {
  return { operation: clone(run.undoOperations.find(operation => operation.path === pathname)),
    result: { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: true, ...overrides } };
}
function mixedResult(run) {
  return { ok: false, applied: [mainReceipt(), deletionReceipt(run)], skipped: [blocked()] };
}
function recovery(run) {
  return Object.fromEntries(['undoOperations', 'undoBaseFiles', 'undoExpectedFiles',
    'undoTrackedChanges', 'trackedChangeCaptures'].map(field => [field, clone(run[field] || [])]));
}
function harness(options = {}) {
  const initial = { id: 'session-a', ...scope, title: 'QA', updatedAt: '2026-10-02T00:00:00.000Z',
    runs: [options.run || pendingRun()] };
  let rows = [clone(initial), ...(options.otherRows || []).map(clone)];
  const state = { activeSessionId: initial.id, sessions: [clone(initial)], runs: clone(initial.runs) };
  const calls = [], writes = [];
  const storage = { ...Db,
    getAllByIndex: async (_store, index, value) => {
      assert.equal(index, 'projectId');
      return clone(rows.filter(row => row.projectId === value));
    },
    putRecords: async (_store, records, writeOptions) => {
      writes.push({ records: clone(records), options: clone(writeOptions) });
      if (options.beforeWrite) await options.beforeWrite();
      if (options.storageError) throw new Error('IDB transaction aborted');
      for (const record of records) {
        assert.equal(record.accountScopeId, scope.accountScopeId);
        assert.equal(record.projectId, scope.projectId);
        const index = rows.findIndex(row => row.id === record.id);
        if (index < 0) rows.push(clone(record)); else rows[index] = clone(record);
      }
      return clone(records);
    },
    deleteRecord: async (_store, id) => { rows = rows.filter(row => row.id !== id); }
  };
  const Migration = { loadPrefs: async () => ({}), savePrefs: async () => {},
    loadSessionTombstones: async () => ({}), getDeletedSessionIds: () => options.deleted ? [initial.id] : [] };
  const persist = async persistenceOptions => {
    calls.push(clone(persistenceOptions));
    return Scope.persistPanelState({ state, compactState: state, projectId: scope.projectId,
      StorageDb: storage, SessionPersistence: Sessions, Migration,
      normalizeExperimentalOtByProject: value => value || {},
      normalizeGovernanceRulesByProject: value => value || {},
      normalizeCustomInstructionsByProject: value => value || {},
      persistenceContext: { scope: options.persistenceScope || scope, nextMeta: {} }, ...persistenceOptions });
  };
  const apply = new Function('state', 'WritebackSettlement', 'FailureReasons', 'Modules', 'flushQueuedSaveState', `
    const findRunRecord = id => state.runs.find(run => run.id === id);
    const buildTrackedUndoPostFiles = run => (run.appliedOperations || [])
      .filter(operation => operation.type === 'edit')
      .map(operation => ({ path: operation.path, content: operation.verifiedContent }));
    ${actionSource}
    return applyTrackedChangeSettlement;
  `)(state, Settlement, FailureReasons, { ScopedPersistenceCoordinator: Scope, UndoOperations: Undo }, persist);
  return { initial, state, calls, writes, apply: (result, kind = 'reject') => apply(initial.runs[0].id, kind, result),
    get run() { return state.runs[0]; }, get rows() { return rows; },
    reload() {
      const saved = rows.find(row => row.id === initial.id);
      return State.normalizePanelState({ sessions: [clone(saved)], activeSessionId: saved.id }).runs[0];
    } };
}
function assertPending(run, expectedPaths, restored = false) {
  assert.equal(run.trackedChangeStatus, restored && !run.undoTrackedChanges.length ? undefined : 'pending',
    'live blocked lifecycle stays pending; refresh removes only the empty tracked lifecycle');
  assert.equal(run.undoStatus, 'partial', 'blocked must not promote Undo to applied');
  assert.deepEqual(run.undoOperations.map(operation => operation.path), expectedPaths);
  assert.equal(run.settlement.evidence.settled, 'needs-review');
  const actions = Settlement.projectRunSettlement(run);
  assert.equal(actions.canUndo, true, 'the real action projection must retain Undo');
  assert.equal(actions.canAccept, run.undoTrackedChanges.length > 0,
    'Accept remains available only while owned tracked references remain');
}

test('blocked mixed Undo persists independently verified progress and the real failure through refresh', async () => {
  const h = harness(), result = mixedResult(h.run), before = clone(result), audit = clone(h.run.appliedOperations);
  assert.equal(h.run.settlement.failures[0].code, 'unknown_legacy_failure');
  assert.equal(Settlement.settleTrackedChangeLifecycle({ kind: 'reject', run: h.run, result }).decision, 'blocked');
  await h.apply(result);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], { preserveRunActionPayload: true, reviewRunIds: ['run-mixed'] });
  for (const [run, restored] of [[h.run, false], [h.state.sessions[0].runs[0], false],
    [h.rows[0].runs[0], false], [h.reload(), true]]) {
    assertPending(run, [nestedPath], restored);
    assert.deepEqual(run.undoExpectedFiles, []);
    assert.deepEqual(run.undoTrackedChanges, []);
    assert.deepEqual(run.undoBaseFiles, [{ path: nestedPath, content: 'nested text' }]);
    assert.equal(run.settlement.failures.length, 1);
    assert.equal(run.settlement.failures[0].code, 'target_file_not_found');
    assert.equal(run.settlement.failures[0].file, nestedPath);
    assert.equal(run.settlement.failures[0].stage, 'navigation');
    assert.equal(run.settlement.failures[0].userMessage, blocked().result.failure.userMessage);
    assert.equal(run.settlement.failures[0].nextAction, blocked().result.failure.nextAction);
  }
  assert.deepEqual(h.run.appliedOperations, audit, 'forward writes remain audit evidence');
  assert.deepEqual(result, before, 'settlement does not mutate the page receipt');
});

test('zero verified progress preserves all recovery but replaces the synthetic unknown failure', async () => {
  const h = harness(), before = recovery(h.run);
  await h.apply({ ok: false, applied: [], skipped: [blocked()] });
  assert.deepEqual(recovery(h.reload()), before);
  assert.equal(h.reload().settlement.failures[0].code, 'target_file_not_found');
  assertPending(h.run, before.undoOperations.map(operation => operation.path));
});

for (const overrides of [{ verified: false }, { verification: 'dom' }, { ok: false }]) {
  test('unverified deletion remains retryable: ' + JSON.stringify(overrides), async () => {
    const h = harness();
    await h.apply({ ok: false, applied: [mainReceipt(), deletionReceipt(h.run, pngPath, overrides)], skipped: [blocked()] });
    assertPending(h.reload(), [pngPath, nestedPath], true);
    assert.deepEqual(h.reload().undoExpectedFiles, []);
  });
}
test('an unverified text receipt does not consume text recovery when the image is independently verified', async () => {
  const h = harness();
  await h.apply({ ok: false, applied: [mainReceipt({ verifiedContent: 'different' }), deletionReceipt(h.run)], skipped: [blocked()] });
  assertPending(h.reload(), ['main.tex', nestedPath], true);
  assert.deepEqual(h.reload().undoExpectedFiles, [{ path: 'main.tex', content: 'before' }]);
  assert.equal(h.reload().undoTrackedChanges.length, 1);
});
test('a failed receipt for the same image overrides its successful-looking deletion receipt', async () => {
  const h = harness(), result = mixedResult(h.run);
  result.skipped.push(blocked(pngPath, 'undo_preflight_content_drift'));
  await h.apply(result);
  assertPending(h.reload(), [pngPath, nestedPath], true);
});
test('a mismatched created-file proof cannot remove the image checkpoint', async () => {
  const h = harness(), result = mixedResult(h.run);
  result.applied[1].operation.undoCreatedFile.sha256 = 'b'.repeat(64);
  await h.apply(result);
  assertPending(h.reload(), [pngPath, nestedPath], true);
});

for (const code of ['aborted_project_changed', 'codex_cancelled']) {
  test('unscoped ' + code + ' retains all recovery, even with successful-looking receipts', async () => {
    const h = harness(), before = recovery(h.run), result = mixedResult(h.run);
    result.skipped = [blocked('', code)];
    await h.apply(result);
    assert.deepEqual(recovery(h.reload()), before);
    assert.equal(h.reload().settlement.failures[0].code, code);
    assertPending(h.run, before.undoOperations.map(operation => operation.path));
  });
}
for (const field of ['failure', 'error']) {
  test('top-level ' + field + ' keeps all recovery material', async () => {
    const h = harness(), before = recovery(h.run), result = mixedResult(h.run);
    result[field] = field === 'failure' ? blocked('', 'aborted_project_changed').result.failure : 'RPC outcome unavailable';
    await h.apply(result);
    assert.deepEqual(recovery(h.reload()), before);
    assertPending(h.run, before.undoOperations.map(operation => operation.path));
  });
}

test('retry uses only the remaining file and reaches rejected only after its verified receipt', async () => {
  const h = harness();
  await h.apply(mixedResult(h.run));
  const restored = h.reload();
  assert.deepEqual(restored.undoOperations.map(operation => operation.path), [nestedPath]);
  const retry = harness({ run: restored });
  await retry.apply({ ok: true, applied: [deletionReceipt(retry.run, nestedPath)], skipped: [] });
  assert.equal(retry.reload().trackedChangeStatus, 'rejected');
  assert.deepEqual(retry.reload().undoOperations, []);
  assert.deepEqual(retry.reload().undoTrackedChanges, []);
  assert.deepEqual(retry.reload().settlement.failures, []);
});

test('the blocked-progress action waits for its durable commit', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ beforeWrite: () => gate });
  let finished = false;
  const action = h.apply(mixedResult(h.run)).then(() => { finished = true; });
  try {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(h.writes.length, 1);
    assert.equal(finished, false);
    assert.equal(h.rows[0].runs[0].undoOperations.length, 3);
  } finally { release(); await action; }
  assertPending(h.reload(), [nestedPath], true);
});

for (const [name, options, code] of [
  ['IDB failure', { storageError: true }, null],
  ['missing account', { persistenceScope: { projectId: scope.projectId } }, 'account_scope_unavailable'],
  ['stale project', { persistenceScope: { ...scope, projectId: 'project-b' } }, 'stale_view'],
  ['deleted session', { deleted: true }, 'review_state_not_persisted']
]) {
  test(name + ' rejects persistence and restores recovery without a false terminal', async () => {
    const h = harness(options), before = recovery(h.run);
    await assert.rejects(h.apply(mixedResult(h.run)), error => code ? error.code === code : /IDB transaction aborted/.test(error.message));
    for (const run of [h.run, h.state.sessions[0].runs[0]]) {
      assert.equal(run.trackedChangeStatus, 'needs_review');
      assert.deepEqual(recovery(run), before);
      assert.equal(run.settlement.failures[0].code, 'unknown_legacy_failure', 'failed commits restore the previous state');
    }
    if (!options.deleted) assert.deepEqual(h.rows[0], h.initial);
  });
}
test('partial progress cannot merge into another account or project', async () => {
  const foreign = [
    { id: 'foreign-account', accountScopeId: 'account-b', projectId: scope.projectId, runs: [pendingRun()] },
    { id: 'foreign-project', accountScopeId: scope.accountScopeId, projectId: 'project-b', runs: [pendingRun()] }
  ];
  const h = harness({ otherRows: foreign });
  await h.apply(mixedResult(h.run));
  assert.deepEqual(h.rows.slice(1), foreign);
  assert.equal(h.writes[0].records.length, 1);
  const updated = h.rows[0];
  for (const field of ['accountScopeId', 'projectId', 'id']) {
    const other = { ...updated, [field]: 'different' };
    assert.equal(Db.mergeSessionReviewState(h.initial, other, ['run-mixed']), h.initial);
  }
});
for (const [name, kind, pureText] of [['Accept', 'accept', false], ['text-only Reject', 'reject', true]]) {
  test('existing blocked ' + name + ' retains its no-commit lifecycle semantics', async () => {
    const run = pendingRun();
    if (pureText) run.undoOperations = run.undoOperations.filter(operation => operation.type === 'edit');
    const h = harness({ run }), before = clone(h.run);
    await h.apply({ ok: false, applied: [], skipped: [blocked('', 'aborted_project_changed')] }, kind);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.run, before);
    assert.deepEqual(h.rows[0], h.initial);
  });
}
test('content runtime remains within its 8000-line ownership budget', () => {
  assert.ok(source.trimEnd().split('\n').length <= 8000);
});
