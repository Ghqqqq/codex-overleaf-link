'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const Actions = require('../extension/src/content/runResultActions');
const { harness, image, digest } = require('./_helpers/undoRuntimeHarness');

test('Track creates have guarded inverses, including empty text and image hash', () => {
  const h = harness();
  assert.equal(h.run.undoOperations.length, 3);
  assert.equal(h.context.getRunUndoCount(h.run), 3);
  assert.equal(h.state.events.some(event => event.title === 'undoCheckpointMissing'), false);
  assert.equal(h.run.undoBaseFiles.find(file => file.path === 'qa/empty.tex').content, '');
  assert.equal(h.run.undoOperations.find(op => op.path.endsWith('.png')).undoCreatedFile.sha256, digest(image));
  assert.equal(Actions.create().projectUndoAvailability(h.run, Settlement.projectRunSettlement).canUndo, true);
});
for (const track of [true, false]) test('created-only Undo removes text and binary files with Track=' + track, async () => {
  const h = harness({ track }); await h.undo();
  assert.equal(h.run.undoStatus, 'applied', JSON.stringify(h.state.events));
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.equal(h.state.removed.length, 3);
});
for (const track of [true, false]) test('mixed existing edit and creations fully undo with Track=' + track, async () => {
  const h = harness({ track, mixed: true }); await h.undo();
  assert.equal(track ? h.run.trackedChangeStatus : h.run.undoStatus, track ? 'rejected' : 'applied');
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
  assert.equal(h.state.requests.filter(request => request.method === 'rejectTrackedChanges').length, 1);
});
test('refresh preserves created-file proof and the mixed Undo action', async () => {
  const h = harness({ mixed: true });
  const stored = Storage.buildSessionRecord({ id: 'qa-session', projectId: h.run.runProjectId,
    requireReviewing: true, runs: [h.run] }, { preserveRunActionPayload: true });
  const restored = Session.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)), { restoreRunningRuns: true })[0];
  assert.equal(restored.undoOperations.length, 3);
  assert.deepEqual(restored.undoOperations, JSON.parse(JSON.stringify(h.run.undoOperations)));
  Object.assign(h.run, restored); await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected');
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
});
for (const kind of ['text', 'binary']) test('changed created ' + kind + ' survives partial Undo and can retry', async () => {
  const h = harness({ mixed: true });
  const target = kind === 'text' ? 'qa/a.tex' : 'qa/probe.png';
  const original = { ...h.docs.get(target) };
  h.docs.set(target, kind === 'text' ? { path: target, content: 'collaborator edit' }
    : { path: target, contentBase64: Buffer.from('replacement').toString('base64') });
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'needs_review');
  assert.equal(h.docs.has(target), true);
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.deepEqual(h.run.undoOperations.map(operation => operation.path), [target]);
  assert.deepEqual(h.run.undoExpectedFiles, []);
  assert.deepEqual(h.run.undoTrackedChanges, []);
  h.docs.set(target, original); await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected');
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
  assert.equal(h.state.removed.length, 3, 'successful siblings are not deleted twice');
});
test('failed text restoration keeps new assets and their recovery records', async () => {
  const h = harness({ mixed: true }); h.docs.get('main.tex').content = 'collaborator text';
  await h.undo();
  assert.notEqual(h.run.trackedChangeStatus, 'rejected');
  assert.equal(Settlement.projectRunSettlement(h.run).canUndo, true);
  assert.equal(h.state.removed.length, 0);
  assert.equal(h.state.requests.some(request => request.method === 'applyOperations'), false);
  assert.equal(h.run.undoOperations.length, 3);
});
test('project switch cannot delete created files', async () => {
  const h = harness(); h.state.projectId = 'other'; await h.undo();
  assert.equal(h.state.removed.length, 0);
  assert.notEqual(h.run.undoStatus, 'applied');
});
test('file selection leaves unselected creations reversible', async () => {
  const h = harness({ selectedPaths: ['qa/a.tex'] }); await h.undo();
  assert.equal(h.run.undoStatus, 'partial');
  assert.equal(h.docs.has('qa/a.tex'), false);
  assert.equal(h.docs.has('qa/empty.tex'), true);
  assert.equal(h.docs.has('qa/probe.png'), true);
});
test('unproven binary creation and original-file collisions never become delete checkpoints', () => {
  const checkpoint = Undo.buildCreatedFileUndoCheckpoint({ files: [{ path: 'existing.tex', content: 'keep' }] }, [
    { type: 'create', path: 'existing.tex', content: 'new' },
    { type: 'binary-create', path: 'image.png' },
    { type: 'overwrite-binary', path: 'old.png', sha256: digest(image) }
  ]);
  assert.deepEqual(checkpoint.undoOperations, []);
});
test('created text guard follows verified subsequent edits', () => {
  const checkpoint = Undo.buildCreatedFileUndoCheckpoint({ files: [] }, [
    { type: 'create', path: 'new.tex', content: 'first' },
    { type: 'edit', path: 'new.tex', verifiedContent: 'final' }
  ]);
  assert.deepEqual(checkpoint.undoBaseFiles, [{ path: 'new.tex', content: 'final' }]);
});
test('Accept keeps new files and closes their Undo alongside tracked edits', async () => {
  const h = harness({ mixed: true });
  Object.assign(h.run, Settlement.applySettlementTransition(h.run, Settlement.settleTrackedChangeLifecycle({
    run: h.run, kind: 'accept', result: { ok: true, applied: [{ trackedChange: { path: 'main.tex' }, result: { ok: true } }], skipped: [] }
  })));
  assert.equal(h.run.trackedChangeStatus, 'accepted');
  assert.equal(Settlement.projectRunSettlement(h.run).canUndo, false);
  assert.equal(h.docs.size, 4);
});

test('transient deletion failure retries only the unfinished file through real native routing', async () => {
  const h = harness({ mixed: true, failFirstDelete: true });
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'needs_review');
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.deepEqual(h.run.undoOperations.map(operation => operation.path), ['qa/a.tex']);
  assert.deepEqual(h.run.undoTrackedChanges, []);
  assert.deepEqual(h.run.undoExpectedFiles, []);
  assert.equal(h.state.checkpointAtDelete.trackedChangeStatus, 'needs_review');
  assert.equal(h.state.checkpointAtDelete.undoOperations.length, 3);
  assert.equal(h.state.checkpointAtDelete.undoTrackedChanges.length, 0, 'text receipt is durable before the delete stage');
  const meta = Actions.create().projectCompletionMeta([{ key: 'undo', value: '4 reversible writes' }], h.run, {
    tx: english => english, trackedChangeInFlight: new Map(), isTrackedChangeLifecycleRun: () => true,
    projectRunSettlement: Settlement.projectRunSettlement
  });
  assert.match(meta[0].value, /remaining files/);
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected');
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
  assert.equal(h.state.requests.filter(request => request.method === 'rejectTrackedChanges').length, 1);
  assert.deepEqual(h.state.requests.filter(request => request.method === 'applyOperations')
    .map(request => request.params.operations.map(operation => operation.path)),
    [['qa/probe.png', 'qa/empty.tex', 'qa/a.tex'], ['qa/a.tex']]);
  assert.equal(h.state.undoClicks, 1, 'native Undo must not run a second time');
});

test('persisted partial progress restores without resurrecting completed native references', async () => {
  const h = harness({ mixed: true, failFirstDelete: true }); await h.undo();
  assert.equal(h.state.savedRun.undoOperations.length, 1);
  assert.equal(h.state.savedRun.undoTrackedChanges.length, 0);
  Object.assign(h.run, Session.normalizeRuns(JSON.parse(JSON.stringify([h.state.savedRun])),
    { restoreRunningRuns: true })[0]);
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected');
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
  assert.equal(h.state.undoClicks, 1);
});

test('later user edits and their native changes survive retry of a remaining created file', async () => {
  const h = harness({ mixed: true, failFirstDelete: true }); await h.undo();
  const main = h.docs.get('main.tex');
  main.content = 'before\n% collaborator edit\n';
  main.changes.push({ id: 'unrelated', op: { p: 7, i: '% collaborator edit\n' } });
  await h.undo();
  assert.equal(h.run.trackedChangeStatus, 'rejected');
  assert.equal(main.content, 'before\n% collaborator edit\n');
  assert.equal(main.changes[0].id, 'unrelated');
  assert.equal(h.state.undoClicks, 1);
  assert.deepEqual([...h.docs.keys()], ['main.tex']);
});

test('a project switch after the persisted text checkpoint cannot delete another project file', async () => {
  const h = harness({ mixed: true, navigateAfterCheckpoint: true }); await h.undo();
  assert.equal(h.state.removed.length, 0);
  assert.notEqual(h.run.trackedChangeStatus, 'rejected');
  assert.equal(h.run.undoOperations.length, 3);
  assert.equal(h.state.savedRun.runProjectId, 'qa-project');
});

test('failure to persist text progress stops before any created-file deletion', async () => {
  const h = harness({ mixed: true, failCheckpointPersistence: true });
  await assert.rejects(h.undo(), /checkpoint persistence unavailable/);
  assert.equal(h.state.requests.some(request => request.method === 'applyOperations'), false);
  assert.equal(h.state.removed.length, 0);
  assert.equal(h.run.undoOperations.length, 3);
  assert.equal(h.run.trackedChangeStatus, 'needs_review');
  assert.equal(h.context.trackedChangeInFlight.size, 0);
});
