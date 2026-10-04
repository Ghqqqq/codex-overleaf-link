'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Controller = require('../extension/src/content/writebackController');
const Undo = require('../extension/src/shared/undoOperations');
const Intent = require('../extension/src/shared/writebackIntent');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const Router = require('../extension/src/page/writebackRouter');
const Guard = require('../extension/src/page/writeGuard');
const Stale = require('../extension/src/shared/staleGuard');
const Files = require('../extension/src/shared/projectFiles');
const { fixture, sha } = require('./_helpers/fileMoveFixture');
const proof = { v: 1, kind: 'text', sha256: sha('original contents\n'), sourceEntityId: 'entity-source', targetEntityId: 'entity-source' };
const move = { type: 'move', path: 'old.tex', to: 'new.tex', moveProof: proof };
test('Controller preserves an explicit move and its destination/content proof', () => {
  const [operation] = Controller.buildSyncApplyOperations([move], { files: [{ path: 'old.tex', content: 'original contents\n' }] });
  assert.equal(operation.type, 'move'); assert.equal(operation.to, 'new.tex'); assert.deepEqual(operation.moveProof, proof);
});
test('move intent roundtrip keeps proof while rejecting malformed provided proof', () => {
  const base = { id: 'intent', projectId: 'p', accountScopeId: 'a', sessionId: 's', runId: 'r', operations: [move] };
  assert.deepEqual(Intent.normalize(base).operations[0].moveProof, proof);
  assert.equal(Intent.normalize({ ...base, operations: [{ ...move, moveProof: { ...proof, sha256: 'invalid' } }] }), null);
});
test('proved moves create an identity-bound inverse and survive storage and normalization', () => {
  const project = { files: [{ path: 'old.tex', content: 'original contents\n' }] };
  const inverse = Undo.buildUndoCheckpoint(project, [move]).undoOperations[0];
  assert.equal(inverse.path, 'new.tex'); assert.equal(inverse.to, 'old.tex'); assert.equal(inverse.moveProof.sourceEntityId, proof.targetEntityId);
  assert.equal(Undo.isFileUndoOperation(inverse), true);
  const stored = Storage.buildSessionRecord({ id: 's', projectId: 'p', accountScopeId: 'a', runs: [{ id: 'r',
    runProjectId: 'p', appliedOperations: [move], undoOperations: [inverse], undoBaseFiles: [], status: 'completed' }] }, { preserveRunActionPayload: true });
  const restored = Session.normalizeRuns(stored.runs)[0];
  assert.deepEqual(restored.undoOperations[0].moveProof, inverse.moveProof);
});
test('a move with no target identity receipt cannot manufacture an Undo proof', () => {
  const nativeOnly = { ...move, moveProof: { v: 1, kind: 'text', sha256: proof.sha256 } };
  assert.deepEqual(Undo.buildUndoCheckpoint({ files: [] }, [nativeOnly]).undoOperations, []);
});
test('the file checkpoint used by Reviewing retains a proved move inverse', () => {
  const checkpoint = Undo.buildCreatedFileUndoCheckpoint({ files: [{ path: 'old.tex', content: 'original contents\n' }] }, [move]);
  assert.equal(checkpoint.undoOperations.length, 1);
  assert.equal(checkpoint.undoOperations[0].type, 'move'); assert.equal(checkpoint.undoOperations[0].path, 'new.tex');
  assert.equal(checkpoint.undoOperations[0].moveProof.sourceEntityId, 'entity-source');
});
test('file move Undo excludes the relocated document from native text Undo and consumes a verified inverse receipt', () => {
  const inverse = { ...move, path: 'new.tex', to: 'old.tex' };
  const run = { undoOperations: [inverse], undoBaseFiles: [{ path: 'new.tex', content: 'original contents\n' }],
    undoExpectedFiles: [{ path: 'old.tex', content: 'original contents\n' }], undoTrackedChanges: [] };
  assert.deepEqual(Undo.textUndoRun(run).undoExpectedFiles, []);
  const advanced = Undo.advanceUndoCheckpoint(run, { ok: true, applied: [{ operation: inverse,
    result: { ok: true, verified: true, verification: 'overleaf-zip', moveProof: proof } }], skipped: [] });
  assert.deepEqual(advanced.undoOperations, []);
});
test('binary move verified projection keeps binary bytes instead of turning the target into empty text', () => {
  const binary = { ...move, path: 'old.png', to: 'new.png', moveProof: { ...proof, kind: 'binary' } };
  const original = { files: [{ path: 'old.png', kind: 'binary', contentBase64: 'Ymlu', size: 3 }] };
  const next = Controller.mergeVerifiedAppliedFiles({ files: [] }, original, { applied: [{ operation: binary, result: { ok: true } }] });
  assert.equal(next.files[0].kind, 'binary'); assert.equal(next.files[0].contentBase64, 'Ymlu');
  assert.equal(next.files[0].content, undefined);
});
for (const kind of ['text', 'binary']) test('stored historical ' + kind + ' move remains reversible through the current Undo router', async () => {
  const source = kind === 'text' ? 'new.tex' : 'new.png', target = kind === 'text' ? 'old.tex' : 'old.png';
  const h = fixture({ kind, source, target });
  const original = h.files.get(source);
  Object.assign(h.window, { CodexOverleafWriteGuard: Guard, CodexOverleafStaleGuard: Stale });
  const router = Router.create({ window: h.window, treeOperations: h.treeOperations,
    moveFile: h.mover.moveFile, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    ensureEditing: async () => ({ ok: true }), ensureReviewing: async () => ({ ok: true }),
    isEditingConfirmedForNoTraceUndo: () => true, delay: async () => {} });
  const recorded = { ...h.operation, path: target, to: source };
  const checkpoint = Undo.buildUndoCheckpoint({ files: kind === 'text' ? [{ path: target, content: 'original contents\n' }] : [] }, [recorded]);
  const stored = Storage.buildSessionRecord({ id: 's', projectId: h.state.projectId, accountScopeId: 'a', runs: [{ id: 'r',
    runProjectId: h.state.projectId, appliedOperations: [recorded], ...checkpoint, status: 'completed' }] }, { preserveRunActionPayload: true });
  const restored = Session.normalizeRuns(stored.runs)[0];
  const result = await router.applyOperations(restored.undoOperations, { runProjectId: h.state.projectId, reviewingPolicy: 'no-trace-undo' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.files.get(target), original);
  assert.equal(h.files.has(source), false); assert.equal(original.comments[0].id, 'comment-original');
  const repeated = await router.applyOperations(restored.undoOperations, { runProjectId: h.state.projectId, reviewingPolicy: 'no-trace-undo' });
  assert.equal(repeated.ok, true, JSON.stringify(repeated)); assert.equal(h.state.posts.length, 1);
});
test('fresh proof moves cannot use the historical consumer or spoof its internal Undo option', async () => {
  const h = fixture();
  Object.assign(h.window, { CodexOverleafWriteGuard: Guard });
  const router = Router.create({ window: h.window, treeOperations: h.treeOperations,
    moveFile: h.mover.moveFile, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    ensureEditing: async () => ({ ok: true }) });
  for (const noTraceUndo of [false, true]) {
    const result = await router.applyOperations([h.operation], { runProjectId: h.state.projectId, requireEditing: true, noTraceUndo });
    assert.equal(result.ok, false); assert.equal(result.skipped[0].result.code, 'file_tree_controls_unavailable');
  }
  assert.equal(h.state.posts.length, 0); assert.equal(h.state.snapshots, 0);
});
for (const type of ['rename', 'move']) test('pre-B02 generic ' + type + ' remains available without metadata proof', async () => {
  const files = new Set(['old.tex']);
  const manager = { async renameEntity(from, to) { files.delete(from); files.add(to); },
    async moveEntity(from, to) { files.delete(from); files.add(to); } };
  const router = Router.create({ window: {}, normalizeSafeProjectPath: Files.normalizeSafeProjectPath,
    treeOperations: { getProjectId: () => 'p', projectPathExists: path => files.has(path), findFileTreeManager: () => manager },
    delay: async () => {} });
  const result = await router.applyOperations([{ type, path: 'old.tex', to: 'new.tex' }], { runProjectId: 'p' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual([...files], ['new.tex']);
});
test('an incomplete move retains its location evidence in the persisted report failure', async () => {
  const h = fixture({ target: 'dest/new.tex', unknownStep: 1 }); const result = await h.move();
  assert.ok(result.moveRecovery);
  const stored = Storage.buildSessionRecord({ id: 's', projectId: h.state.projectId, accountScopeId: 'a',
    runs: [{ id: 'r', runProjectId: h.state.projectId, status: 'failed',
      events: [{ title: 'Move needs review', kind: 'report', status: 'failed', failure: result.failure }] }] });
  const restored = Session.normalizeRuns(stored.runs)[0];
  assert.deepEqual(restored.events[0].failure.evidence.moveRecovery, result.moveRecovery);
});
test('a successful receipt binds inverse moves to the original doc/file identity namespace', async () => {
  const h = fixture(); const moved = await h.move(); assert.equal(moved.ok, true);
  const verified = Settlement.attachVerifiedContentToOperation(h.operation, moved);
  const inverse = Undo.buildUndoCheckpoint({ files: [] }, [verified]).undoOperations[0];
  assert.equal(inverse.moveProof.entityType, 'doc');
  h.files.get('new.tex').type = 'file';
  const result = await h.move(inverse); assert.equal(result.ok, false); assert.equal(h.state.posts.length, 1);
});
test('inverse move completes the file operation and reports remaining observed directories for manual cleanup', async () => {
  let h; const checked = [];
  h = fixture({ target: 'created/new.tex', async prepareUploadParent(folder, options) {
    options.isCurrent();
    if (!h.folders.has(folder) && options.createMissing) {
      h.folders.set(folder, 'created-folder');
      options.onCreatedDirectory({ v: 1, projectId: h.state.projectId, path: folder, nativeFolderId: 'created-folder',
        ownershipConfirmed: false, observedAfterCreate: true });
    }
  }, async cleanupCreatedDirectories(directories, options) {
    options.isCurrent(); checked.push(...directories);
    return { ok: false, removed: [], remaining: directories, requiresExplicitCleanup: true };
  } });
  const moved = await h.move(); assert.equal(moved.ok, true, JSON.stringify(moved));
  const verified = Settlement.attachVerifiedContentToOperation(h.operation, moved);
  const inverse = Undo.buildUndoCheckpoint({ files: [] }, [verified]).undoOperations[0];
  assert.equal(inverse.moveProof.createdDirectories[0].path, 'created');
  const result = await h.move(inverse);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.files.get('old.tex').id, 'entity-source');
  assert.equal(checked.length, 1); assert.equal(result.directoryCleanup.remaining[0].path, 'created');
  assert.equal(h.folders.has('created'), true);
  assert.equal(h.state.posts.some(post => post.action === 'delete'), false);
});
