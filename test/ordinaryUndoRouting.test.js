const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const projectFiles = require('../extension/src/shared/projectFiles');
const routerModule = require('../extension/src/page/writebackRouter');
const lifecycleModule = require('../extension/src/page/trackedChangesLifecycle');
const captureModule = require('../extension/src/page/trackedChangeCapture');
const guardModule = require('../extension/src/page/writeGuard');
const settlementModule = require('../extension/src/shared/writebackSettlement');
const storageDb = require('../extension/src/shared/storageDb');
const sessionState = require('../extension/src/shared/sessionState');
const undoOperations = require('../extension/src/shared/undoOperations');
const captureControllerModule = require('../extension/src/content/trackedChangeCaptureController');
const snapshotCodec = require('../extension/src/shared/runExecutionSnapshotCodec');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8');
const functionStart = runtimeSource.indexOf('  async function undoRunTrackedChanges(');
const functionEnd = runtimeSource.indexOf('  async function acceptRun(', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart);
const undoSource = runtimeSource.slice(functionStart, functionEnd);

// Exercise the actual content dispatch and page router with the native ledger
// adapter present. Omitting that adapter bypasses the production review guard.
function createHarness(spec = {}) {
  const rows = spec.files || [{ path: 'main.tex', before: 'Before.\n', post: 'Before.\n% undo-test\n' }];
  const docs = new Map(rows.map((row, index) => [row.path, {
    ...row, id: 'doc-' + index, text: row.post, changes: row.changes || []
  }]));
  const state = { activePath: rows[0].path, reviewing: false, clicks: [], writes: [], opened: [], requests: [], mirrorRequests: [] };
  const current = () => docs.get(state.activePath);
  const window = {
    _ide: { project: { _id: 'example-project' } },
    document: { querySelector: () => null },
    setTimeout, clearTimeout,
    CodexOverleafTrackedChangeCapture: captureModule,
    CodexOverleafTrackedChangesLifecycle: lifecycleModule,
    CodexOverleafWriteGuard: guardModule
  };
  const nativeView = () => spec.ledgerUnavailable ? null : { state: {
    doc: { toString: () => current().text, get length() { return current().text.length; } },
    values: [{ ranges: { docId: current().id, changes: current().changes, comments: [] }, threads: {} }]
  } };
  const undoControl = { tagName: 'BUTTON', disabled: false, getAttribute: name => name === 'aria-label' ? 'Undo' : null };
  const router = routerModule.create({
    window,
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath,
    getCodeMirrorEditorView: nativeView,
    getTrackedChangeDocumentId: file => docs.get(file)?.id || '',
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isReviewingConfirmedForWrite: review => review?.reviewing?.ok === true,
    isEditingConfirmedForNoTraceUndo: review => review?.reviewing?.ok === false,
    ensureEditing: async () => ({ ok: true }),
    ensureReviewing: async () => ({ ok: true }),
    setReviewingEnabled: async enabled => { state.reviewing = enabled; return { ok: true, enabled }; },
    compileBridge: { markSourceEdited() { state.sourceEdited = true; } },
    collectElements: selector => /button/i.test(selector) && !spec.noUndoControl ? [undoControl] : [],
    isInsideCodexPanel: () => false,
    readNodeSignalText: node => node === undoControl ? 'Undo' : '',
    clickNode(node) {
      assert.equal(node, undoControl);
      state.clicks.push(state.activePath);
      current().text = spec.undoHistoryText ?? current().before;
      current().changes = [];
    },
    readActiveEditorText: () => current().text,
    replaceActiveEditorText(text) {
      state.writes.push({ path: state.activePath, text });
      current().text = text;
      return { ok: true };
    },
    replaceActiveEditorPatches(patches, nextContent) {
      state.writes.push({ path: state.activePath, text: nextContent, patches });
      current().text = nextContent;
      return { ok: true };
    },
    waitForSaveState: async () => ({ ok: true, state: 'verified_saved' }),
    delay: async () => {},
    treeOperations: {
      getProjectId: () => window._ide.project._id,
      getActiveFilePath: () => state.activePath,
      projectPathExists: target => docs.has(target),
      async openFileByPath(target) {
        state.opened.push(target);
        if (!docs.has(target)) return { ok: false };
        state.activePath = target;
        return { ok: true };
      }
    }
  });
  const guard = guardModule.create({ window, sleep: async () => {} });
  const capture = captureModule.create({
    getCodeMirrorEditorView: nativeView,
    getTrackedChangeDocumentId: file => docs.get(file)?.id || '',
    getActiveFilePath: () => state.activePath,
    readActiveEditorText: () => current().text,
    normalizeSafeProjectPath: projectFiles.normalizeSafeProjectPath
  });
  const originalFiles = rows.map(row => ({ path: row.path, content: row.before }));
  const appliedOperations = rows.map(row => ({ type: 'edit', path: row.path, replaceAll: row.post, verifiedContent: row.post }));
  const executionSnapshot = Object.hasOwn(spec, 'snapshot') ? spec.snapshot : snapshotCodec.normalizeSnapshot({
    mode: 'auto', model: 'gpt-5.6-luna', reasoningEffort: 'high', requireReviewing: spec.tracked === true,
    focusFiles: rows.map(row => row.path), capturedAt: '2026-09-11T00:00:00.000Z', source: 'submitted'
  });
  const checkpoint = undoOperations.buildUndoCheckpoint({ files: originalFiles }, appliedOperations);
  const postController = captureControllerModule.create({ buildExpectedFilesAfterOperations: undoOperations.buildExpectedFilesAfterOperations });
  const run = {
    id: 'run-undo', task: 'Disposable example edit', runProjectId: 'example-project', mode: 'auto', status: 'completed',
    executionSnapshot, appliedOperations,
    undoOperations: executionSnapshot?.requireReviewing === true ? [] : checkpoint.undoOperations,
    undoBaseFiles: executionSnapshot?.requireReviewing === true ? [] : checkpoint.undoBaseFiles,
    undoExpectedFiles: originalFiles,
    undoTrackedChanges: spec.tracked
      ? capture.prepareTrackedChangeCapture(state.activePath).refs.filter(ref => ref.id !== 'unrelated')
      : []
  };
  const orchestratorContext = { window: {} };
  vm.runInNewContext(orchestratorSource, orchestratorContext);
  const writebackOrchestrator = orchestratorContext.window.CodexOverleafWritebackOrchestrator.create({
    tx: en => en,
    getCurrentProjectId: () => window._ide.project._id,
    resetContextProject() { state.contextReset = true; },
    async callPageBridge(method) {
      assert.equal(method, 'invalidateProjectSnapshot');
      state.snapshotInvalidated = true;
    },
    async sendBackgroundNative(request) {
      state.mirrorRequests.push(request);
      return { ok: true, result: { invalidated: true } };
    },
    appendRunRecordEvent() { assert.fail('mirror invalidation should succeed in this fixture'); }
  });
  const undo = vm.runInNewContext('(' + undoSource + ')', {
    writebackOrchestrator,
    showPluginConfirm: async () => true,
    tr: key => key,
    truncateRunTitle: value => value,
    formatTrackedChangeFiles: () => '',
    formatTrackedUndoFiles: () => '',
    isTrackedChangeLifecycleRun: record => record.undoTrackedChanges.length > 0,
    trackedChangeInFlight: new Map(),
    refreshRunCardControls() {},
    setRunUndoStatus: (_id, status) => { state.status = status; },
    appendRunRecordEvent() {},
    buildTrackedUndoPostFiles: record => postController.buildPostFiles(record),
    getTrackedChangeCaptureController: () => postController,
    getRunProjectIdForWriteback: record => record.runProjectId,
    requireReviewing: spec.currentTrack === true,
    async callPageBridge(method, params) {
      state.requests.push(params);
      return await guard.runWriteGuard(params) || await router[method](params);
    },
    formatBridgeResultReason: result => result?.code || '',
    WritebackSettlement: settlementModule,
    buildContentFailure: (code, data) => ({ code, ...data }),
    applyTrackedChangeSettlement: (_id, _action, result) => { state.result = result; state.status = result.ok ? 'rejected' : 'needs_review'; },
    applyLegacyUndoSettlement: (_id, status, result) => { state.result = result; state.status = status; }
  });
  return { docs, state, run, router, window, async undo(record) {
      await undo(run.id, record || run);
      await writebackOrchestrator.getPendingMirrorRefresh();
    },
    pageParams: () => ({ runProjectId: run.runProjectId, untrackedUndo: true, trackedChanges: [],
      expectedFiles: run.undoExpectedFiles.map(file => ({ ...file })), postFiles: postController.buildPostFiles(run) }) };
}

function persistAndRestoreRun(run) {
  const record = storageDb.buildSessionRecord({ id: 'session-undo', projectId: run.runProjectId,
    requireReviewing: true, runs: [run] }, { preserveRunActionPayload: true });
  return sessionState.normalizeRuns(JSON.parse(JSON.stringify(record.runs)), { restoreRunningRuns: true })[0];
}

function assertUnchanged(harness) {
  assert.equal(harness.state.clicks.length, 0);
  assert.equal(harness.state.writes.length, 0);
  assert.equal(harness.state.mirrorRequests.length, 0);
  for (const doc of harness.docs.values()) assert.equal(doc.text, doc.post);
}

test('ordinary Undo uses the frozen Track-off intent and restores its checkpoint without editor Undo', async () => {
  const h = createHarness({ currentTrack: true });
  await h.undo();
  assert.equal(h.state.requests[0].untrackedUndo, true);
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.state.result.applied.length, 1);
  assert.equal(h.docs.get('main.tex').text, h.run.undoExpectedFiles[0].content);
  assert.deepEqual(h.state.clicks, []);
  assert.equal(h.state.writes.length, 1);
  assert.deepEqual(h.state.mirrorRequests.map(request => ({ method: request.method, projectId: request.params.projectId })),
    [{ method: 'mirror.invalidate', projectId: 'example-project' }]);
  assert.equal(h.state.contextReset, true);
  assert.equal(h.state.snapshotInvalidated, true);
});

test('ordinary Undo restores both root and nested files', async () => {
  const h = createHarness({ files: [
    { path: 'main.tex', before: 'Root.\n', post: 'Root.\n% test\n' },
    { path: 'example/test.tex', before: 'Nested.\n', post: 'Nested.\n% test\n' }
  ] });
  await h.undo();
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.state.result.applied.length, 2);
  for (const doc of h.docs.values()) assert.equal(doc.text, doc.before);
});

test('ordinary Undo accepts an empty-string pre-image as a complete checkpoint', async () => {
  const h = createHarness({ files: [{ path: 'main.tex', before: '', post: 'new\n' }] });
  await h.undo();
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.docs.get('main.tex').text, '');
});

test('ordinary Undo after reload restores its no-trace checkpoint', async () => {
  const h = createHarness({ noUndoControl: true });
  const restored = persistAndRestoreRun(h.run);
  assert.deepEqual(restored.executionSnapshot, h.run.executionSnapshot);
  await h.undo(restored);
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.state.clicks.length, 0);
  assert.equal(h.state.writes.length, 1);
  assert.equal(h.docs.get('main.tex').text, h.run.undoExpectedFiles[0].content);
});

test('ordinary Undo never resurrects an older user edit from the global history', async () => {
  const h = createHarness({ undoHistoryText: 'Before.\n% undo-test\n% older user edit\n' });
  await h.undo();
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.docs.get('main.tex').text, 'Before.\n');
  assert.equal(h.state.clicks.length, 0);
  assert.equal(h.state.writes.length, 1);
});

test('ordinary Undo preserves a later non-overlapping user edit', async () => {
  const h = createHarness();
  const doc = h.docs.get('main.tex');
  doc.text += '% later user edit\n';
  await h.undo();
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(doc.text, doc.before + '% later user edit\n');
  assert.equal(h.state.clicks.length, 0);
});

test('a conflicting checkpoint cannot fall back to unrelated editor history', async () => {
  const h = createHarness();
  const doc = h.docs.get('main.tex');
  doc.text = 'Rewritten by the user.\n';
  await h.undo();
  assert.equal(h.state.status, 'partial');
  assert.equal(h.state.result.skipped[0].result.code, 'snapshot_undo_current_mismatch');
  assert.equal(doc.text, 'Rewritten by the user.\n');
  assert.equal(h.state.clicks.length, 0);
  assert.equal(h.state.writes.length, 0);
  assert.equal(h.state.mirrorRequests.length, 0);
});

for (const [name, snapshot] of [
  ['original Track-on', { requireReviewing: true, source: 'submitted' }],
  ['missing snapshot without legacy proof', undefined],
  ['inferred legacy snapshot', { requireReviewing: false, source: 'legacy-inferred' }],
  ['unknown snapshot source', { requireReviewing: false, source: 'unknown' }]
]) {
  test('empty refs do not bypass the native guard for ' + name, async () => {
    const h = createHarness({ snapshot, currentTrack: false });
    if (!snapshot) h.run.undoOperations = [];
    await h.undo();
    assert.equal(h.state.requests[0].untrackedUndo, false);
    assert.equal(h.state.status, 'partial');
    assert.equal(h.state.result.skipped[0].result.code, 'native_review_identity_unavailable');
    assertUnchanged(h);
  });
}

for (const [name, mutate] of [
  ['missing post-image', run => { run.postFiles = []; }],
  ['different paths', run => { run.postFiles[0].path = 'example/test.tex'; }],
  ['duplicate pre-images', params => { params.expectedFiles.push({ ...params.expectedFiles[0] }); }],
  ['duplicate post-images', run => { run.postFiles.push({ ...run.postFiles[0] }); }],
  ['invalid content', params => { params.expectedFiles[0].content = null; }],
  ['unsafe path', params => { params.expectedFiles[0].path = '../main.tex'; }]
]) {
  test('ordinary Undo rejects ' + name + ' before any mutation', async () => {
    const h = createHarness();
    const params = h.pageParams();
    mutate(params);
    h.state.result = await h.router.rejectTrackedChanges(params);
    assert.equal(h.state.result.skipped[0].result.code, 'native_untracked_undo_checkpoint_unavailable');
    assertUnchanged(h);
  });
}

test('ordinary Undo refuses a file with another pending native change', async () => {
  const h = createHarness({ files: [{ path: 'main.tex', before: 'a', post: 'ab', changes: [{ id: 'unrelated', op: { p: 0, d: 'x' } }] }] });
  await h.undo();
  assert.equal(h.state.result.skipped[0].result.code, 'native_untracked_undo_pending_changes');
  assertUnchanged(h);
});

test('ordinary Undo refuses an unavailable native ledger', async () => {
  const h = createHarness({ ledgerUnavailable: true });
  await h.undo();
  assert.equal(h.state.result.skipped[0].result.code, 'native_review_unavailable');
  assertUnchanged(h);
});

test('Accept cannot use the untracked Undo intent to bypass ref ownership', async () => {
  const h = createHarness();
  const result = await h.router.acceptTrackedChanges({
    ...h.pageParams()
  });
  assert.equal(result.skipped[0].result.code, 'native_review_identity_unavailable');
  assertUnchanged(h);
});

test('owned tracked-change Undo retains the existing editor Undo path', async () => {
  const h = createHarness({ tracked: true, snapshot: { requireReviewing: true, source: 'submitted' },
    files: [{ path: 'main.tex', before: 'a', post: 'ab', changes: [{ id: 'owned', op: { p: 1, i: 'b' } }] }] });
  await h.undo();
  assert.equal(h.state.status, 'rejected', JSON.stringify(h.state.result));
  assert.equal(h.docs.get('main.tex').text, 'a');
  assert.deepEqual(h.state.clicks, ['main.tex']);
});

test('tracked-change Undo still refuses mixed ownership', async () => {
  const h = createHarness({ tracked: true, snapshot: { requireReviewing: true, source: 'submitted' },
    files: [{ path: 'main.tex', before: 'a', post: 'ab', changes: [
      { id: 'owned', op: { p: 1, i: 'b' } }, { id: 'unrelated', op: { p: 0, d: 'x' } }
    ] }] });
  await h.undo();
  assert.equal(h.state.result.skipped[0].result.code, 'native_reject_mixed_changes');
  assertUnchanged(h);
});

test('ordinary Undo remains bound to the original project at the transport guard', async () => {
  const h = createHarness();
  h.window._ide.project._id = 'different-project';
  await h.undo();
  assert.equal(h.state.result.skipped[0].result.code, 'aborted_project_changed');
  assertUnchanged(h);
});


test('real storage recovery preserves a two-file untracked Undo despite the current Track setting', async () => {
  const h = createHarness({ currentTrack: true, noUndoControl: true, files: [
    { path: 'main.tex', before: 'Root.\n', post: 'Root.\n% QA\n' },
    { path: 'example/test.tex', before: '', post: '% QA\n' }
  ] });
  let restored = h.run;
  for (let cycle = 0; cycle < 3; cycle++) restored = persistAndRestoreRun(restored);
  assert.deepEqual(restored.executionSnapshot, h.run.executionSnapshot);
  assert.equal(restored.executionSnapshot.requireReviewing, false);
  assert.equal(restored.undoExpectedFiles.length, 2);
  await h.undo(restored);
  assert.equal(h.state.requests[0].untrackedUndo, true);
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  assert.equal(h.state.result.applied.length, 2);
  assert.equal(h.state.clicks.length, 0);
  assert.equal(h.state.writes.length, 2);
  for (const doc of h.docs.values()) assert.equal(doc.text, doc.before);
});

test('snapshot-free legacy runs recover only through a complete bidirectional checkpoint', async () => {
  const h = createHarness({ snapshot: undefined, currentTrack: true, noUndoControl: true, files: [
    { path: 'main.tex', before: 'Root.\n', post: 'Root.\n% QA\n' },
    { path: 'example/test.tex', before: '', post: '% QA\n' }
  ] });
  const restored = persistAndRestoreRun(h.run);
  assert.equal(restored.executionSnapshot, undefined);
  await h.undo(restored);
  assert.equal(h.state.requests[0].untrackedUndo, true);
  assert.equal(h.state.status, 'applied', JSON.stringify(h.state.result));
  for (const doc of h.docs.values()) assert.equal(doc.text, doc.before);
});

for (const [name, corrupt] of [
  ['missing inverse operations', run => { run.undoOperations = []; }],
  ['missing stored post-images', run => { run.undoBaseFiles = []; }],
  ['changed stored post-image', run => { run.undoBaseFiles[0].content = 'foreign content'; }],
  ['invalid inverse operation', run => { run.undoOperations[0].replaceAll = 'foreign content'; }],
  ['changed forward proof', run => { run.appliedOperations[0].verifiedContent = 'foreign content'; }],
  ['duplicate pre-images', run => { run.undoExpectedFiles.push({ ...run.undoExpectedFiles[0] }); }],
  ['structural inverse operation', run => { run.undoOperations[0].type = 'delete'; }],
  ['pending capture', run => { run.trackedChangeCaptures = [{ state: 'pending' }]; }]
]) {
  test('legacy recovery refuses ' + name + ' without weakening the native guard', async () => {
    const h = createHarness({ snapshot: undefined });
    corrupt(h.run);
    await h.undo(h.run);
    assert.equal(h.state.requests[0].untrackedUndo, false);
    assertUnchanged(h);
  });
}

test('legacy recovery still refuses another pending native change in the target file', async () => {
  const h = createHarness({ snapshot: undefined, files: [
    { path: 'main.tex', before: 'a', post: 'ab', changes: [{ id: 'unrelated', op: { p: 0, d: 'x' } }] }
  ] });
  await h.undo(persistAndRestoreRun(h.run));
  assert.equal(h.state.requests[0].untrackedUndo, true);
  assert.equal(h.state.result.skipped[0].result.code, 'native_untracked_undo_pending_changes');
  assertUnchanged(h);
});

test('an explicit original Track-on snapshot vetoes a legacy-looking inverse checkpoint', async () => {
  const h = createHarness({ snapshot: { requireReviewing: true, source: 'submitted' } });
  Object.assign(h.run, undoOperations.buildUndoCheckpoint({ files: h.run.undoExpectedFiles }, h.run.appliedOperations));
  await h.undo(persistAndRestoreRun(h.run));
  assert.equal(h.state.requests[0].untrackedUndo, false);
  assertUnchanged(h);
});
