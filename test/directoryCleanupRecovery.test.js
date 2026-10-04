'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Proof = require('../extension/src/shared/directoryCleanupProof');
const Recovery = require('../extension/src/content/directoryCleanupRecovery');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const { extractFunction } = require('./_helpers/extractFunction');
const { fixture: pageFixture } = require('./_helpers/createdDirectoryFixture');
const owner = { projectId: 'example', accountScopeId: 'account-A', sessionId: 'session-A', runId: 'run-A' };
const directory = { v: 1, projectId: owner.projectId, path: 'qa', nativeFolderId: 'created-qa', ownershipConfirmed: false, observedAfterCreate: true };
const wrapper = dirs => ({ v: 1, ...owner, directories: dirs || [directory] });
const failed = (code = 'file_tree_operation_unverified') => ({ ok: false, applied: [], skipped: [
  { operation: { type: 'create', path: 'qa/leaf.tex', content: 'generated' }, result: { ok: false, code, changedDocument: true,
    fileUploadAttempted: false, createdDirectories: [directory] } }
] });
function harness(options = {}) {
  const run = { id: owner.runId, runProjectId: owner.projectId, status: 'failed', startedAt: '2026-10-04T00:00:00Z', undoOperations: [] };
  const state = { activeSessionId: owner.sessionId, sessions: [{ id: owner.sessionId, runs: [run] }] };
  const scope = { projectId: owner.projectId, accountScopeId: owner.accountScopeId, generation: 1 };
  const target = { recordId: owner.runId, sessionId: owner.sessionId, runProjectId: owner.projectId, runAccountScopeId: owner.accountScopeId };
  const io = { stored: null, persists: 0, calls: [], notifications: [], current: null };
  const page = pageFixture({ folders: ['qa'], snapshotMetadata: options.snapshotMetadata }); page.folders.set('qa', directory.nativeFolderId);
  // The object-method declaration is adapted mechanically to extract its
  // unchanged production body; only the transport itself is replaced.
  const pageBridgeSource = fs.readFileSync(path.join(__dirname, '../extension/src/pageBridge.js'), 'utf8')
    .replace('    checkCreatedDirectories(params) {', '    function checkCreatedDirectories(params) {');
  const pageCheck = vm.runInNewContext('(' + extractFunction(pageBridgeSource, 'checkCreatedDirectories') + ')', {
    textFileCreator: page.creator, getProjectId: () => page.state.project, readWriteCancellationSequence: () => io.pageSequence || 0
  });
  const controller = Recovery.create({
    getProjectId: () => scope.projectId, getAccountScopeId: () => scope.accountScopeId, getRouteGeneration: () => scope.generation,
    getState: () => state, getCurrentRun: () => io.current, findRunRecord: (id, session) => id === run.id && session === owner.sessionId ? run : null,
    async persist(params) {
      io.persists++; assert.equal(params.requireDurable, true); assert.equal(params.preserveRunActionPayload, true);
      if (options.failPersist) throw new Error('synthetic persistence failure');
      io.stored = Storage.buildSessionRecord({ id: owner.sessionId, projectId: owner.projectId, accountScopeId: owner.accountScopeId, runs: [run] }, { preserveRunActionPayload: true });
      options.afterPersist?.({ run, scope, io });
    },
    readSession: async () => io.stored,
    async callPageBridge(method, params) {
      io.calls.push({ method, params }); assert.equal(method, 'checkCreatedDirectories'); assert.equal(params.runProjectId, owner.projectId);
      options.beforePageResult?.({ run, scope, state, io });
      if (options.pageResult) return options.pageResult;
      return pageCheck(params);
    },
    notify: (...args) => io.notifications.push(args), refresh() {}, tx: (_en, zh) => zh
  });
  const context = vm.createContext({ state, Modules: { DirectoryCleanupRecovery: Recovery },
    currentRunView: target, getDirectoryCleanupRecovery: () => controller,
    getAppliedEntries: result => result.applied || [], getSkippedEntries: result => result.skipped || [],
    findRunRecord: () => run,
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint, buildUndoCheckpoint: Undo.buildUndoCheckpoint,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    refreshRunCardControls() {}, appendRunEvent() {}, tr: value => value, formatOperationType: value => value });
  const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  vm.runInContext(extractFunction(runtime, 'recordUndoFromApply'), context);
  return { run, state, scope, target, io, page, controller,
    record: result => context.recordUndoFromApply({ id: owner.projectId, files: [] }, result),
    restore: () => Session.normalizeRuns(JSON.parse(JSON.stringify(io.stored.runs)), { restoreRunningRuns: true })[0] };
}

test('schema binds every directory to owner and cannot promote observed identity into ownership', () => {
  assert.equal(Proof.normalize({ ...wrapper(), accountScopeId: '' }), null);
  assert.equal(Proof.normalize(wrapper([{ ...directory, projectId: 'another' }])), null);
  assert.equal(Proof.normalize(wrapper([{ ...directory, path: '../unsafe' }])), null);
  assert.equal(Proof.normalize(wrapper([{ ...directory, path: 'qa\\sub' }])), null);
  assert.equal(Proof.normalize(wrapper([{ ...directory, ownershipConfirmed: true }])).directories[0].ownershipConfirmed, false);
  assert.equal(Proof.normalize(wrapper(Array.from({ length: 101 }, (_, i) => ({ ...directory, path: 'qa/' + i })))), null);
  assert.equal(Proof.normalize(wrapper(Array.from({ length: 50 }, (_, i) => ({ ...directory, path: '中'.repeat(1000) + i })))), null);
  assert.equal(Proof.merge({ ...owner, accountScopeId: 'B' }, wrapper(), [directory]), null);
});
for (const code of ['file_tree_operation_unverified', 'codex_cancelled']) {
  test('real runtime zero-applied ' + code + ' persists directory recovery without inventing file Undo', async () => {
    const h = harness(); await h.record(failed(code));
    assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper()); assert.deepEqual(h.run.undoOperations, []);
    assert.equal(h.io.persists, 1);
    assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  });
}
test('successful creation evidence alone does not create a premature cleanup notice', () => {
  const h = harness();
  const capture = h.controller.capture(h.target, { applied: [{ operation: { path: 'qa/leaf.tex' }, result: { ok: true, createdDirectories: [directory] } }] });
  assert.equal(capture, null); assert.equal(h.run.pendingDirectoryCleanup, undefined);
});
test('reload retains the independent notice after file Undo/Accept terminal state', async () => {
  for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
    const h = harness(); Object.assign(h.run, terminal);
    const capture = h.controller.capture(h.target, failed()); await h.controller.persist(capture);
    assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  }
});
test('read-only check retains present empty folders and clears only observed manual removal', async () => {
  const h = harness(); await h.controller.persist(h.controller.capture(h.target, failed()));
  const first = await h.controller.check(owner.runId);
  assert.equal(first.ok, false); assert.equal(first.deletedByCheck, false); assert.equal(h.page.folders.has('qa'), true);
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper()); assert.deepEqual(h.page.removed, []);
  h.page.folders.delete('qa');
  const second = await h.controller.check(owner.runId);
  assert.equal(second.ok, true); assert.equal(h.run.pendingDirectoryCleanup, undefined);
  assert.equal(h.restore().pendingDirectoryCleanup, undefined); assert.deepEqual(h.page.removed, []);
});
for (const kind of ['account', 'project', 'session', 'active-run']) {
  test('scope change during check cannot clear directory recovery: ' + kind, async () => {
    const h = harness({ beforePageResult({ scope, state, io }) {
      if (kind === 'account') scope.accountScopeId = 'account-B';
      if (kind === 'project') scope.projectId = 'other-project';
      if (kind === 'session') state.activeSessionId = 'other-session';
      if (kind === 'active-run') io.current = { recordId: 'other-run' };
    } });
    await h.controller.persist(h.controller.capture(h.target, failed())); h.page.folders.delete('qa');
    await assert.rejects(h.controller.check(owner.runId), /changed/);
    assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  });
}
test('missing read evidence cannot be treated as cleanup completion', async () => {
  const h = harness({ pageResult: { ok: true, remaining: [], removed: [] } });
  await h.controller.persist(h.controller.capture(h.target, failed()));
  await assert.rejects(h.controller.check(owner.runId), /omitted/); assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
});
test('failed durable save restores the pending check record and never emits completion', async () => {
  const options = {}, h = harness(options); await h.controller.persist(h.controller.capture(h.target, failed()));
  h.page.folders.delete('qa'); options.failPersist = true;
  await assert.rejects(h.controller.check(owner.runId), /persistence failure/);
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper()); assert.equal(h.io.notifications.length, 0);
});
test('collector ignores unrelated paths and keeps non-applied binary directory metadata', () => {
  const input = failed(); input.skipped[0].operation.type = 'binary-create'; input.skipped[0].result.createdDirectories.push({ ...directory, path: 'unrelated' });
  assert.deepEqual(Recovery.collect(input), [directory]);
});
test('directory metadata rejection cannot skip the real file Undo checkpoint', async () => {
  const h = harness();
  const paths = Array.from({ length: 101 }, (_, index) => Array(index + 1).fill('a').join('/'));
  const result = failed(); result.skipped[0].operation.path = paths.at(-1) + '/leaf.tex';
  result.skipped[0].result.createdDirectories = paths.map(value => ({ ...directory, path: value }));
  result.applied.push({ operation: { type: 'create', path: 'extra.tex', content: 'new' }, result: { ok: true } });
  await assert.rejects(h.record(result), /bounded storage format/);
  assert.equal(h.run.undoOperations.some(item => item.path === 'extra.tex'), true);
});
test('different account rejects checks before any project data request', async () => {
  const h = harness(); await h.controller.persist(h.controller.capture(h.target, failed()));
  h.scope.accountScopeId = 'account-B';
  await assert.rejects(h.controller.check(owner.runId), /another project or account/);
  assert.equal(h.io.calls.length, 0); assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
});

test('real Page handler rejects a different project without clearing content recovery', async () => {
  const h = harness(); await h.controller.persist(h.controller.capture(h.target, failed()));
  h.page.state.project = 'another-page-project'; h.page.folders.delete('qa');
  const result = await h.controller.check(owner.runId);
  assert.equal(result.ok, false); assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.page.removed, []);
});
test('failed forward move persists only source or destination ancestor directories through runtime and storage', async () => {
  const h = harness(), input = failed();
  input.skipped[0].operation = { type: 'move', path: 'old/source.tex', to: 'qa/leaf.tex' };
  input.skipped[0].result.createdDirectories.push(...['unrelated', 'qaz', 'qa/leaf.tex', 'qa/leaf.tex/child'].map(value => ({ ...directory, path: value })));
  await h.record(input);
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  assert.equal(h.io.persists, 1); assert.deepEqual(h.run.undoOperations, []);
});
test('successful inverse move retains source-side directory leftovers for readonly cleanup', async () => {
  const h = harness();
  const input = { ok: true, applied: [{ operation: { type: 'move', path: 'qa/leaf.tex', to: 'old/source.tex' },
    result: { ok: true, verified: true, directoryCleanup: { ok: false, remaining: [directory] } } }], skipped: [] };
  await h.controller.persist(h.controller.capture(h.target, input));
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.run.undoOperations, []);
});
test('other operations cannot borrow a to path to collect unrelated directory evidence', () => {
  for (const type of ['create', 'edit', 'delete', 'binary-create']) {
    const input = failed(); input.skipped[0].operation = { type, path: 'old/source.tex', to: 'qa/leaf.tex' };
    assert.deepEqual(Recovery.collect(input), []);
  }
});
test('move destination paths must be normalized before authorizing their parent metadata', () => {
  for (const to of ['qa/../elsewhere/leaf.tex', 'qa//leaf.tex', 'qa/leaf.tex\u0000', 'qa/leaf.tex ', '/qa/leaf.tex', 'C:/qa/leaf.tex', 'qa\\leaf.tex']) {
    const input = failed(); input.skipped[0].operation = { type: 'move', path: 'old/source.tex', to };
    assert.deepEqual(Recovery.collect(input), [], to);
  }
});

test('incomplete ZIP identity cannot clear a missing-directory recovery notice or announce completion', async () => {
  const h = harness({ snapshotMetadata: { pathIdentityComplete: false } });
  await h.controller.persist(h.controller.capture(h.target, failed())); h.page.folders.delete('qa');
  const result = await h.controller.check(owner.runId);
  assert.equal(result.ok, false); assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper()); assert.deepEqual(h.page.removed, []);
  assert.equal(h.io.notifications.some(([message]) => message.includes('目录收尾检查完成')), false);
});
