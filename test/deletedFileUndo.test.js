'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./_helpers/undoRuntimeHarness');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const original = () => [{ path: 'main.tex', content: 'before\n' }, { path: 'old.tex', content: 'old original\n' }];
const edit = { type: 'edit', path: 'main.tex', replaceAll: 'before\n% mixed\n', verifiedContent: 'before\n% mixed\n' };
const deletion = { type: 'delete', path: 'old.tex' };
const creation = { type: 'create', path: 'new.tex', content: 'new\n' };
function setup(track, operations, options = {}) { return harness({ track, files: original(), operations, ...options }); }
function reload(h) {
  const saved = Storage.buildSessionRecord({ id: 'qa-session', projectId: 'qa-project', runs: [h.run] }, { preserveRunActionPayload: true });
  const restored = Session.normalizeRuns(JSON.parse(JSON.stringify(saved.runs)), { restoreRunningRuns: true })[0];
  for (const key of Object.keys(h.run)) delete h.run[key];
  Object.assign(h.run, restored);
}
function assertOriginal(h) {
  assert.equal(h.docs.get('main.tex')?.content, 'before\n');
  assert.equal(h.docs.get('old.tex')?.content, 'old original\n');
  assert.equal(h.docs.has('new.tex'), false);
}
for (const track of [false, true]) {
  for (const [name, operations] of [['edit control', [edit]], ['creation control', [creation]],
    ['edit and creation control', [edit, creation]], ['deletion', [deletion]],
    ['edit and deletion', [edit, deletion]], ['edit deletion and creation', [edit, deletion, creation]]]) {
    for (const persisted of [false, true]) test(`${name}; Track=${track}; reload=${persisted}`, async () => {
      const h = setup(track, operations); if (persisted) reload(h); await h.undo(); assertOriginal(h);
      assert.equal(h.run.trackedChangeStatus === 'rejected' || h.run.undoStatus === 'applied', true);
    });
  }
}
test('historical Track-on deletion reconstructs only a proven deleted original', async () => {
  const h = setup(true, [deletion]); h.run.undoOperations = []; h.run.undoBaseFiles = []; reload(h);
  await h.undo(); assertOriginal(h);
});
for (const track of [false, true]) test(`same-path later file is preserved and deletion recovery remains; Track=${track}`, async () => {
  const h = setup(track, [edit, deletion]); h.docs.set('old.tex', { path: 'old.tex', content: 'later user file\n' });
  await h.undo(); assert.equal(h.docs.get('old.tex').content, 'later user file\n');
  assert.notEqual(h.run.undoStatus, 'applied'); assert.notEqual(h.run.trackedChangeStatus, 'rejected');
  assert.equal(h.run.undoOperations.some(op => op.type === 'create' && op.path === 'old.tex'), true);
});
for (const track of [false, true]) test(`failed restore preserves progress for reload and retry; Track=${track}`, async () => {
  const h = setup(track, [edit, deletion, creation], { failCreate: true }); await h.undo();
  assert.equal(h.docs.get('main.tex').content, 'before\n'); assert.equal(h.docs.has('old.tex'), false);
  assert.equal(h.run.undoOperations.some(op => op.type === 'create' && op.path === 'old.tex'), true);
  const beforeRetries = h.state.requests.filter(request => request.method === 'rejectTrackedChanges').length;
  reload(h); await h.undo(); assertOriginal(h);
  assert.equal(h.state.requests.filter(request => request.method === 'rejectTrackedChanges').length, beforeRetries);
});
for (const track of [false, true]) test(`deleted empty original remains a valid restoration; Track=${track}`, async () => {
  const h = setup(track, [deletion], { files: [{ path: 'main.tex', content: 'before\n' }, { path: 'old.tex', content: '' }] });
  reload(h); await h.undo(); assert.equal(h.docs.get('old.tex')?.content, ''); assert.equal(h.run.undoStatus, 'applied');
});
for (const track of [false, true]) test(`later conflicting text blocks mixed restoration without changing either file; Track=${track}`, async () => {
  const h = setup(track, [edit, deletion]); h.docs.get('main.tex').content = 'later conflicting rewrite\n';
  await h.undo(); assert.equal(h.docs.get('main.tex').content, 'later conflicting rewrite\n');
  assert.equal(h.docs.has('old.tex'), false); assert.notEqual(h.run.undoStatus, 'applied');
  assert.notEqual(h.run.trackedChangeStatus, 'rejected');
});
for (const track of [false, true]) test(`deleted original remains bound to its project; Track=${track}`, async () => {
  const h = setup(track, [deletion]); h.state.projectId = 'other-project'; await h.undo();
  assert.equal(h.docs.has('old.tex'), false); assert.equal(h.state.created.length, 0); assert.notEqual(h.run.undoStatus, 'applied');
});
test('historical pre-image without a forward delete never authorizes reconstruction', async () => {
  const h = setup(true, [deletion]); h.run.undoOperations = []; h.run.appliedOperations = []; reload(h);
  await h.undo(); assert.equal(h.docs.has('old.tex'), false); assert.equal(h.state.requests.length, 0);
});
test('a create then delete never authorizes resurrecting a transient file', async () => {
  const h = setup(true, [creation, { type: 'delete', path: 'new.tex' }]); reload(h); await h.undo();
  assert.equal(h.docs.has('new.tex'), false); assert.equal(h.state.requests.length, 0);
});
for (const track of [false, true]) test(`edit then delete on the same original path restores its original pre-image; Track=${track}`, async () => {
  const h = setup(track, [edit, { type: 'delete', path: 'main.tex' }]);
  if (track) { // Refs captured by the successful edit can survive the later file deletion in the apply result.
    h.run.undoTrackedChanges = setup(true, [edit]).run.undoTrackedChanges;
    h.run.trackedChangeStatus = 'pending';
  }
  reload(h); await h.undo(); assertOriginal(h);
  assert.equal(h.state.created.filter(path => path === 'main.tex').length, 1);
});
for (const track of [false, true]) test(`partial multi-file restoration never replays a verified create after reload; Track=${track}`, async () => {
  const h = setup(track, [edit, deletion, { type: 'delete', path: 'other.tex' }], {
    files: [...original(), { path: 'other.tex', content: 'other original\n' }], failCreate: true, failCreatePath: 'other.tex'
  });
  await h.undo(); assert.equal(h.docs.get('old.tex')?.content, 'old original\n'); assert.equal(h.docs.has('other.tex'), false);
  assert.equal(h.run.undoOperations.some(op => op.path === 'old.tex'), false);
  reload(h); await h.undo(); assertOriginal(h); assert.equal(h.docs.get('other.tex')?.content, 'other original\n');
  assert.equal(h.state.createAttempts.filter(path => path === 'old.tex').length, 1);
  assert.equal(h.state.createAttempts.filter(path => path === 'other.tex').length, 2);
});
test('partial deleted-file recovery is projected as retryable partial Undo', async () => {
  const Actions = require('../extension/src/content/runResultActions').create();
  const Settlement = require('../extension/src/shared/writebackSettlement');
  const h = setup(true, [edit, deletion], { failCreate: true });
  h.context.tr = (key, params) => require('../extension/src/shared/i18n').t('en', key, params);
  h.context.appendRunRecordEvent = (_id, event) => { h.run.events = [...(h.run.events || []), event]; };
  await h.undo();
  const rows = Actions.projectCompletionMeta([{ key: 'undo', value: '2 undoable' }], h.run, {
    tx: en => en, isTrackedChangeLifecycleRun: run => Boolean(run.trackedChangeStatus),
    projectRunSettlement: Settlement.projectRunSettlement
  });
  assert.equal(rows[0].value, 'Some changes were undone; retry the remaining files.');
  assert.equal(Actions.summarizeCompletionMeta(rows, h.run, { tx: en => en }).facts.find(row => row.key === 'undo').text, 'Partly undone');
});
