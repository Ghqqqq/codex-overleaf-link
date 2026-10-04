'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./_helpers/createdDirectoryFixture');
const proof = (path, id = 'created-' + path) => ({ v: 1, projectId: 'example', path, nativeFolderId: id, ownershipConfirmed: false, observedAfterCreate: true });

test('successful nested text creation records only new native folder identities', async () => {
  const f = fixture({ folders: ['qa'] }), result = await f.create('qa/sub/leaf.tex');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.createdDirectories, [proof('qa/sub')]);
  assert.equal(f.files.get('main.tex'), 'original');
});
test('folder-only failure preserves empty parents for explicit cleanup and never claims file submission', async () => {
  const f = fixture({ duplicateUpload: true }), result = await f.create('qa/sub/leaf.tex');
  assert.equal(result.ok, false); assert.equal(f.files.has('qa/sub/leaf.tex'), false);
  assert.deepEqual([...f.folders.keys()], ['qa', 'qa/sub']); assert.deepEqual(f.removed, []);
  assert.equal(result.fileUploadAttempted, false); assert.equal(result.directoryCleanup.ok, false);
  assert.equal(result.directoryCleanup.review.find(item => item.path === 'qa/sub').empty, true);
  assert.equal(result.directoryCleanup.requiresExplicitCleanup, true);
  assert.doesNotMatch(result.reason, /file was submitted/i);
});
test('file Undo verifies file deletion and leaves directory proof for explicit native cleanup', async () => {
  const f = fixture(), created = await f.create('qa/sub/leaf.tex');
  assert.equal(created.ok, true);
  const result = await f.undo('qa/sub/leaf.tex', created.createdDirectories);
  assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.fileDeleted, true);
  assert.deepEqual(f.removed, ['qa/sub/leaf.tex']);
  assert.deepEqual(result.directoryCleanup.remaining, created.createdDirectories);
  assert.deepEqual([...f.folders.keys()], ['qa', 'qa/sub']); assert.equal(f.files.get('main.tex'), 'original');
});
test('binary upload parent preparation reports new directory proofs without deleting them', async () => {
  const f = fixture({ folders: ['assets'] }); await f.prepare('assets/sub');
  assert.deepEqual(f.proofs, [proof('assets/sub')]); assert.deepEqual([...f.folders.keys()], ['assets', 'assets/sub']);
});
for (const scenario of ['nonempty', 'identity-changed', 'identity-missing', 'project-changed', 'cancelled', 'skipped']) {
  test('cleanup retains proof and avoids unsafe deletion: ' + scenario, async () => {
    const f = fixture({ folders: ['qa'], wrongDialog: scenario === 'wrong-dialog', skipped: scenario === 'skipped' ? [{ path: 'qa/hidden.bin' }] : [] });
    f.folders.set('qa', 'created-qa');
    if (scenario === 'nonempty') f.files.set('qa/later.tex', 'collaborator');
    if (scenario === 'identity-changed') f.folders.set('qa', 'replacement-id');
    if (scenario === 'identity-missing') f.folders.set('qa', '');
    if (scenario === 'project-changed') f.state.project = 'another-project';
    if (scenario === 'cancelled') f.state.current = false;
    const result = await f.cleanup([proof('qa')]);
    assert.equal(result.ok, false); assert.equal(f.folders.has('qa'), true); assert.equal(f.removed.length, 0);
    assert.deepEqual(result.remaining, [proof('qa')]);
  });
}
test('empty directory review never dispatches a destructive menu or delete confirmation', async () => {
  const f = fixture({ folders: ['qa'], beforeDialog() { throw new Error('Directory delete must not be invoked'); } });
  f.folders.set('qa', 'created-qa');
  const result = await f.cleanup([proof('qa')]);
  assert.equal(result.ok, false); assert.deepEqual(f.removed, []);
  assert.equal(result.review[0].empty, true); assert.equal(result.requiresExplicitCleanup, true);
  f.files.set('qa/later.tex', 'collaborator');
  assert.equal(f.files.has('qa/later.tex'), true); assert.equal(f.folders.has('qa'), true);
});
test('failed directory cleanup after file deletion retains the original proof for an idempotent retry', async () => {
  const f = fixture(), created = await f.create('qa/sub/leaf.tex');
  f.files.set('qa/sub/later.tex', 'collaborator');
  const first = await f.undo('qa/sub/leaf.tex', created.createdDirectories);
  assert.equal(first.ok, false); assert.equal(first.fileDeleted, true); assert.equal(f.files.has('qa/sub/leaf.tex'), false);
  assert.deepEqual(first.directoryCleanup.remaining, created.createdDirectories);
  f.files.delete('qa/sub/later.tex');
  // Explicit native cleanup is an external user action, outside the plugin.
  f.folders.delete('qa/sub'); f.folders.delete('qa');
  const second = await f.undo('qa/sub/leaf.tex', created.createdDirectories);
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(f.folders.size, 0);
  assert.equal(f.removed.filter(path => path.endsWith('.tex')).length, 1);
});
test('unconfirmed creation and cancelled creation retain recovery evidence and accurate wording', async () => {
  for (const cancelled of [false, true]) {
    const f = fixture({ duplicateUpload: true, noFolderIdentity: !cancelled,
      onCreated: cancelled ? (path, h) => { h.state.current = false; } : undefined });
    const result = await f.create('qa/sub/leaf.tex');
    assert.equal(result.ok, false); assert.equal(result.fileUploadAttempted, false);
    assert.equal(result.createdDirectories.length > 0, true);
    assert.equal(result.directoryCleanup.remaining.length > 0, true);
    assert.equal(f.removed.length, 0); assert.doesNotMatch(result.reason, /file was submitted/i);
  }
});

test('observed same-name folder after create is never promoted to proven ownership', async () => {
  const f = fixture({ onCreated(path, h) { h.folders.set(path, 'concurrent-' + path); } });
  const result = await f.create('qa/leaf.tex');
  assert.equal(result.ok, true); assert.equal(result.createdDirectories[0].nativeFolderId, 'concurrent-qa');
  assert.equal(result.createdDirectories[0].ownershipConfirmed, false);
  assert.equal(result.createdDirectories[0].observedAfterCreate, true);
  const inspected = await f.cleanup(result.createdDirectories);
  assert.equal(inspected.ok, false); assert.deepEqual(f.removed, []);
});
test('unknown upload completion preserves directories even if no file appears yet', async () => {
  const f = fixture({ skipUpload: true });
  const result = await f.create('qa/leaf.tex');
  assert.equal(result.ok, false); assert.equal(result.fileUploadAttempted, true);
  assert.equal(result.directoryCleanup.remaining.length, 1); assert.deepEqual(f.removed, []);
  assert.match(result.reason, /file was submitted/i);
});
test('settlement and checkpoint preserve directory evidence through later edits and checkpoint merge', () => {
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const Undo = require('../extension/src/shared/undoOperations');
  const dirs = [proof('qa')];
  const operation = Settlement.attachVerifiedContentToOperation({ type: 'create', path: 'qa/leaf.tex', content: 'generated' }, { createdDirectories: dirs });
  const first = Undo.buildCreatedFileUndoCheckpoint({ files: [] }, [operation]);
  assert.deepEqual(first.undoOperations[0].undoCreatedFile.createdDirectories, dirs);
  const second = Undo.buildCreatedFileUndoCheckpoint({ files: [] }, [{ type: 'edit', path: 'qa/leaf.tex', verifiedContent: 'later' }], first);
  assert.deepEqual(second.undoOperations[0].undoCreatedFile.createdDirectories, dirs);
  assert.deepEqual(second.undoBaseFiles, [{ path: 'qa/leaf.tex', content: 'later' }]);
});
test('settlement only forwards a valid move result identity proof', () => {
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const move = { type: 'move', path: 'old.tex', to: 'new.tex' };
  const moveProof = { v: 1, kind: 'text', sha256: 'A'.repeat(64), sourceEntityId: 'source', targetEntityId: 'target' };
  const good = Settlement.attachVerifiedContentToOperation(move, { moveProof });
  assert.equal(good.moveProof.sha256, 'a'.repeat(64)); assert.equal(good.moveProof.targetEntityId, 'target');
  assert.equal(Settlement.attachVerifiedContentToOperation(move, { moveProof: { ...moveProof, sha256: 'bad' } }).moveProof, undefined);
  assert.equal(Settlement.attachVerifiedContentToOperation(move, { moveProof: { ...moveProof, targetEntityId: '' } }).moveProof, undefined);
});
test('batch finalization retains the directory metadata from the creating entry', async () => {
  const f = fixture(), operation = { type: 'create', path: 'qa/leaf.tex', content: 'generated' };
  const batch = await f.creator.beginCreateBatch([operation], { isCurrent: () => true });
  const pending = await f.create(operation.path, operation.content, { batch });
  assert.equal(pending.pendingVerification, true);
  const entries = await f.creator.finishCreateBatch(batch, [{ operation, result: pending }]);
  assert.equal(entries[0].result.ok, true);
  assert.deepEqual(entries[0].result.createdDirectories, [proof('qa')]);
});
test('directory evidence survives real storage builder and session restoration', () => {
  const Storage = require('../extension/src/shared/storageDb');
  const Session = require('../extension/src/shared/sessionState');
  const run = { id: 'run-directory', runProjectId: 'example', status: 'completed', startedAt: '2026-10-04T00:00:00Z',
    undoOperations: [{ type: 'delete', path: 'qa/leaf.tex', undoCreatedFile: { v: 1, kind: 'text', createdDirectories: [proof('qa')] } }],
    undoBaseFiles: [{ path: 'qa/leaf.tex', content: 'generated' }] };
  const stored = Storage.buildSessionRecord({ id: 'session', projectId: 'example', runs: [run] }, { preserveRunActionPayload: true });
  const restored = Session.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)), { restoreRunningRuns: true })[0];
  assert.deepEqual(restored.undoOperations[0].undoCreatedFile.createdDirectories, [proof('qa')]);
});
test('ambiguous same-label folder rows remain unknown instead of being marked absent', async () => {
  const f = fixture({ folders: ['qa'], duplicateFolder: 'qa' });
  f.folders.set('qa', 'created-qa');
  const result = await f.cleanup([proof('qa')]);
  assert.equal(result.ok, false); assert.deepEqual(result.remaining, [proof('qa')]);
  assert.equal(result.removed.length, 0); assert.deepEqual(f.removed, []);
});

test('missing native folder row with remaining server descendants retains recovery evidence', async () => {
  const f = fixture({ files: { 'qa/hidden.tex': 'server child' } });
  const result = await f.cleanup([proof('qa')]);
  assert.equal(result.ok, false); assert.deepEqual(result.remaining, [proof('qa')]);
  assert.equal(result.removed.length, 0);
});
