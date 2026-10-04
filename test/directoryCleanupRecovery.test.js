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
  const io = { stored: null, coreWrites: 0, phases: [], omissions: [] };
  const controller = Recovery.create({
    getProjectId: () => scope.projectId, getAccountScopeId: () => scope.accountScopeId, getRouteGeneration: () => scope.generation,
    findRunRecord: (id, session) => id === run.id && session === owner.sessionId ? run : null,
    onOmitted: (...args) => io.omissions.push(args),
    refresh() {}
  });
  // Model the existing caller's later core writer explicitly. Capturing directory
  // metadata must never invoke an additional writer or readback barrier itself.
  async function coreWrite() {
    io.coreWrites++;
    io.phases.push('core-write');
    if (options.failCoreWrite) throw Object.assign(new Error('synthetic core writer failure'), { code: 'fixture_core_writer_failed' });
    io.stored = Storage.buildSessionRecord({ id: owner.sessionId, projectId: owner.projectId,
      accountScopeId: owner.accountScopeId, runs: [run] }, { preserveRunActionPayload: true });
  }
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
  return { run, state, scope, target, io, controller,
    coreWrite,
    async record(result) {
      io.phases.push('record-undo');
      await context.recordUndoFromApply({ id: owner.projectId, files: [] }, result);
      io.phases.push('recorded');
      await coreWrite();
    },
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
    assert.equal(h.io.coreWrites, 1);
    assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  });
}
test('successful creation evidence alone does not create premature cleanup recovery', () => {
  const h = harness();
  const capture = h.controller.capture(h.target, { applied: [{ operation: { path: 'qa/leaf.tex' }, result: { ok: true, createdDirectories: [directory] } }] });
  assert.equal(capture, null); assert.equal(h.run.pendingDirectoryCleanup, undefined);
});
test('reload retains directory evidence after file Undo/Accept terminal state', async () => {
  for (const terminal of [{ undoStatus: 'applied' }, { trackedChangeStatus: 'accepted' }]) {
    const h = harness(); Object.assign(h.run, terminal);
    await h.record(failed());
    assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  }
});
test('collector ignores unrelated paths and keeps non-applied binary directory metadata', () => {
  const input = failed(); input.skipped[0].operation.type = 'binary-create'; input.skipped[0].result.createdDirectories.push({ ...directory, path: 'unrelated' });
  assert.deepEqual(Recovery.collect(input), [directory]);
});
test('directory capacity omission keeps earlier evidence and cannot block the real file Undo checkpoint', async () => {
  const h = harness();
  h.run.pendingDirectoryCleanup = wrapper();
  const paths = Array.from({ length: 101 }, (_, index) => Array(index + 1).fill('a').join('/'));
  const result = failed(); result.skipped[0].operation.path = paths.at(-1) + '/leaf.tex';
  result.skipped[0].result.createdDirectories = paths.map(value => ({ ...directory, path: value }));
  result.applied.push({ operation: { type: 'create', path: 'extra.tex', content: 'new' }, result: { ok: true } });
  await h.record(result);
  assert.equal(h.run.undoOperations.some(item => item.path === 'extra.tex'), true);
  assert.equal(h.restore().undoOperations.some(item => item.path === 'extra.tex'), true);
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  assert.equal(h.io.omissions.length, 1);
  assert.deepEqual(h.io.phases, ['record-undo', 'recorded', 'core-write']);
});
test('failed forward move persists only source or destination ancestor directories through runtime and storage', async () => {
  const h = harness(), input = failed();
  input.skipped[0].operation = { type: 'move', path: 'old/source.tex', to: 'qa/leaf.tex' };
  input.skipped[0].result.createdDirectories.push(...['unrelated', 'qaz', 'qa/leaf.tex', 'qa/leaf.tex/child'].map(value => ({ ...directory, path: value })));
  await h.record(input);
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  assert.equal(h.io.coreWrites, 1); assert.deepEqual(h.run.undoOperations, []);
});
test('successful inverse move retains source-side directory recovery evidence', async () => {
  const h = harness();
  const input = { ok: true, applied: [{ operation: { type: 'move', path: 'qa/leaf.tex', to: 'old/source.tex' },
    result: { ok: true, verified: true, directoryCleanup: { ok: false, remaining: [directory] } } }], skipped: [] };
  h.controller.capture(h.target, input);
  await h.coreWrite();
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


test('directory recovery exposes only passive capture and keeps old evidence through the core writer', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.controller), ['capture']);
  assert.equal(h.controller.persist, undefined);
  assert.equal(h.controller.check, undefined);
  h.run.pendingDirectoryCleanup = wrapper();
  assert.equal(h.controller.capture(h.target, { ok: true, applied: [], skipped: [] }), null);
  assert.equal(h.io.coreWrites, 0);
  await h.coreWrite();
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
});

for (const kind of ['account', 'project', 'session', 'fork', 'record-project', 'missing-account']) {
  test('foreign or unowned capture changes no existing recovery record: ' + kind, () => {
    const h = harness();
    h.run.pendingDirectoryCleanup = wrapper();
    if (kind === 'account') h.target.runAccountScopeId = 'account-B';
    if (kind === 'project') h.target.runProjectId = 'other-project';
    if (kind === 'session') h.target.sessionId = 'other-session';
    if (kind === 'fork') h.run.forkSnapshot = true;
    if (kind === 'record-project') h.run.runProjectId = 'other-project';
    if (kind === 'missing-account') h.scope.accountScopeId = '';
    const before = JSON.stringify(h.run);
    assert.equal(h.controller.capture(h.target, failed()), null);
    assert.equal(JSON.stringify(h.run), before);
    assert.equal(h.io.coreWrites, 0);
    assert.equal(h.io.stored, null);
  });
}

test('the original core writer failure still rejects without inventing durable directory evidence', async () => {
  const h = harness({ failCoreWrite: true });
  await assert.rejects(h.record(failed()), error => error.code === 'fixture_core_writer_failed');
  assert.deepEqual(h.run.pendingDirectoryCleanup, wrapper());
  assert.equal(h.io.stored, null);
  assert.equal(h.io.coreWrites, 1);
  assert.deepEqual(h.io.phases, ['record-undo', 'recorded', 'core-write']);
});

test('binary failure evidence travels through runtime capture and the original core writer', async () => {
  const h = harness(), result = failed();
  result.skipped[0].operation.type = 'binary-create';
  await h.record(result);
  assert.deepEqual(h.restore().pendingDirectoryCleanup, wrapper());
  assert.deepEqual(h.restore().undoOperations, []);
  assert.equal(h.io.coreWrites, 1);
});

test('incomplete ZIP identity remains unproven at the internal directory cleanup helper', async () => {
  const f = pageFixture({ snapshotMetadata: { pathIdentityComplete: false } });
  const result = await f.cleanup([directory]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.remaining, [directory]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(f.removed, []);
});
