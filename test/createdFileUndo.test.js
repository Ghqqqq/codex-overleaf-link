'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { createHash, webcrypto } = require('node:crypto');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Router = require('../extension/src/page/writebackRouter');
const StaleGuard = require('../extension/src/shared/staleGuard');
const WriteGuard = require('../extension/src/page/writeGuard');
const ProjectFiles = require('../extension/src/shared/projectFiles');
const Capture = require('../extension/src/content/trackedChangeCaptureController');
const Storage = require('../extension/src/shared/storageDb');
const Session = require('../extension/src/shared/sessionState');
const Actions = require('../extension/src/content/runResultActions');
const NativeCapture = require('../extension/src/page/trackedChangeCapture');
const Lifecycle = require('../extension/src/page/trackedChangesLifecycle');
const Scope = require('../extension/src/content/scopedPersistencePanelState');
const FailureReasons = require('../extension/src/shared/failureReasons');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
function extract(name) {
  const match = new RegExp('^  (?:async )?function ' + name + '\\(', 'm').exec(runtime);
  assert.ok(match, name);
  const rest = runtime.slice(match.index + match[0].length);
  const next = /\n  (?:async )?function /.exec(rest);
  return runtime.slice(match.index, next ? match.index + match[0].length + next.index : runtime.length);
}
const image = Buffer.from('disposable binary fixture');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const createOperations = () => [
  { type: 'create', path: 'qa/a.tex', content: '% created\n' },
  { type: 'create', path: 'qa/empty.tex', content: '' },
  { type: 'binary-create', path: 'qa/probe.png', sha256: digest(image), size: image.length }
];
function harness(options = {}) {
  const project = { id: 'qa-project', files: [{ path: 'main.tex', content: 'before\n' }] };
  const docs = new Map(project.files.map(file => [file.path, { ...file }]));
  const operations = [...(options.mixed ? [{ type: 'edit', path: 'main.tex', replaceAll: 'before\n% mixed\n', verifiedContent: 'before\n% mixed\n' }] : []), ...createOperations()];
  for (const op of operations) docs.set(op.path, op.type === 'binary-create'
    ? { path: op.path, contentBase64: image.toString('base64') }
    : { path: op.path, content: op.replaceAll ?? op.content });
  const state = { projectId: project.id, activePath: 'main.tex', reviewing: options.track !== false,
    requests: [], removed: [], events: [], prompts: [] };
  const run = { id: 'created-run', task: 'Disposable files', mode: 'auto', status: 'completed',
    runProjectId: project.id, executionSnapshot: { requireReviewing: options.track !== false, source: 'submitted' },
    appliedOperations: [], undoOperations: [], undoBaseFiles: [], undoExpectedFiles: [], undoTrackedChanges: [] };
  const capture = Capture.create({ buildExpectedFilesAfterOperations: Undo.buildExpectedFilesAfterOperations });
  for (const file of docs.values()) {
    file.id = 'doc-' + file.path;
    file.before = project.files.find(original => original.path === file.path)?.content;
    file.changes = options.mixed && options.track !== false && file.path === 'main.tex'
      ? [{ id: 'owned', op: { p: 7, i: '% mixed\n' } }] : [];
  }
  const undoControl = { tagName: 'BUTTON', disabled: false,
    getAttribute: name => name === 'aria-label' ? 'Undo' : null };
  const views = new Map();
  for (const file of docs.values()) if (typeof file.content === 'string') views.set(file.path, { state: {
    doc: { toString: () => docs.get(file.path)?.content || '', get length() { return docs.get(file.path)?.content?.length || 0; } },
    values: [{ ranges: { docId: file.id, changes: file.changes, comments: [] }, threads: {} }]
  } });
  const window = { document: { querySelector: () => null }, crypto: webcrypto, setTimeout, clearTimeout,
    _ide: { project: { get _id() { return state.projectId; } } },
    CodexOverleafTrackedChangeCapture: NativeCapture, CodexOverleafTrackedChangesLifecycle: Lifecycle,
    CodexOverleafStaleGuard: StaleGuard, CodexOverleafWriteGuard: WriteGuard, CodexOverleafProjectFiles: ProjectFiles };
  const router = Router.create({ window, writebackOpenSettleMs: 0,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    treeOperations: { getProjectId: () => state.projectId, getActiveFilePath: () => state.activePath,
      projectPathExists: target => docs.has(target), async openFileByPath(target) {
        if (!docs.has(target)) return { ok: false }; state.activePath = target; return { ok: true };
      } },
    getCodeMirrorEditorView: () => views.get(state.activePath),
    getTrackedChangeDocumentId: target => docs.get(target)?.id || '',
    collectElements: selector => /button/i.test(selector) ? [undoControl] : [],
    isInsideCodexPanel: () => false,
    readNodeSignalText: node => node === undoControl ? 'Undo' : '',
    clickNode(node) {
      assert.equal(node, undoControl); state.undoClicks = (state.undoClicks || 0) + 1;
      const file = docs.get(state.activePath); file.content = file.before; file.changes.splice(0);
    },
    replaceActiveEditorText(content) { docs.get(state.activePath).content = content; return { ok: true }; },
    replaceActiveEditorPatches(_patches, content) { docs.get(state.activePath).content = content; return { ok: true }; },
    waitForSaveState: async () => ({ ok: true, state: 'verified_saved' }),
    getActiveEditorIdentity: () => views.get(state.activePath) || null,
    activeEditorIdentityChanged: previous => previous !== views.get(state.activePath),
    readActiveEditorText: () => docs.get(state.activePath)?.content,
    getReviewingState: () => ({ reviewing: { ok: state.reviewing }, signals: {} }),
    isEditingConfirmedForNoTraceUndo: value => value.reviewing.ok === false,
    isReviewingConfirmedForWrite: value => value.reviewing.ok === true,
    setReviewingEnabled: async enabled => { state.reviewing = enabled; return { ok: true, enabled }; },
    ensureEditing: async () => { state.reviewing = false; return { ok: true }; },
    ensureReviewing: async () => { state.reviewing = true; return { ok: true }; },
    delay: async () => {}, compileBridge: { markSourceEdited() {} },
    projectSnapshotBridge: { getProjectSnapshot: async () => ({ id: state.projectId, files: [...docs.values()] }) },
    async deleteTextFile(operation, config) {
      if (!config.isCurrent()) return { ok: false, code: 'aborted_project_changed' };
      const file = docs.get(operation.path);
      if (options.failFirstDelete && operation.path === 'qa/a.tex' && !state.deleteFailed) {
        state.deleteFailed = true;
        return { ok: false, code: 'file_tree_controls_unavailable', changedDocument: false,
          reason: 'Server source ZIP is unavailable; deletion cannot be verified safely.' };
      }
      if (!file) return { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: false, idempotent: true };
      const matches = operation.undoCreatedFile.kind === 'binary'
        ? digest(Buffer.from(file.contentBase64 || '', 'base64')) === config.expectedSha256
        : file.content === config.expectedContent;
      if (!matches || !config.canDelete()) return { ok: false, code: 'undo_operation_failed', changedDocument: false };
      docs.delete(operation.path); state.removed.push(operation.path);
      return { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: true };
    }
  });
  const context = {
    currentRunView: { recordId: run.id, sessionId: 'qa-session', executionSnapshot: run.executionSnapshot },
    state: { requireReviewing: options.track !== false, runs: [run],
      sessions: [{ id: 'qa-session', projectId: project.id, runs: [run] }] }, findRunRecord: () => run,
    Modules: { ScopedPersistenceCoordinator: Scope, UndoOperations: Undo }, FailureReasons,
    async flushQueuedSaveState() {
      if (options.failCheckpointPersistence) throw new Error('checkpoint persistence unavailable');
      const stored = Storage.buildSessionRecord(context.state.sessions[0], { preserveRunActionPayload: true });
      state.savedRun = Session.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)), { restoreRunningRuns: true })[0];
      if (options.navigateAfterCheckpoint && !run.undoExpectedFiles.length && run.undoOperations.length) state.projectId = 'other';
    },
    saveStateSoon() { context.flushQueuedSaveState(); },
    getAppliedEntries: value => value.applied || [], getSkippedEntries: value => value.skipped || [],
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint,
    buildUndoCheckpoint: Undo.buildUndoCheckpoint,
    getTrackedChangeCaptureController: () => capture,
    hasTrackedEditorUndo: value => capture.buildPostFiles(value).length > 0,
    buildTrackedUndoPostFiles: value => capture.buildPostFiles(value),
    buildNoTraceUndoRestore: Undo.buildSnapshotRestoreUndo,
    findUnsafeFullFileUndoOperation: () => null,
    getPendingMirrorRefresh: () => null, appendRunEvent: event => state.events.push(event),
    appendRunRecordEvent: (_id, event) => state.events.push(event),
    refreshRunCardControls() {}, tr: key => key, truncateRunTitle: value => value,
    formatOperationFiles: rows => rows.map(row => row.path).join(', '),
    formatTrackedChangeFiles: rows => rows.map(row => row.path).join(', '),
    formatTrackedUndoFiles: () => 'main.tex', formatOperationType: value => value,
    formatApplyResultReason: value => value.result?.code || '', formatBridgeResultReason: value => value?.code || '',
    appendUndoReviewingPolicyEvent() {},
    showPluginConfirm: async value => { state.prompts.push(value); return true; },
    showUndoFileSelection: async value => { state.prompts.push(value); return options.selectedPaths || value.paths; },
    setRunUndoStatus: (_id, value) => { run.undoStatus = value; },
    isTrackedChangeLifecycleRun: value => Boolean(value.trackedChangeStatus || value.undoTrackedChanges?.length),
    trackedChangeInFlight: new Map(), getRunProjectIdForWriteback: value => value.runProjectId,
    WritebackSettlement: Settlement, buildContentFailure: (code, details) => ({ code, ...details }),
    writebackOrchestrator: { invalidateMirrorAfterUndo() {} },
    isUndoResultEffectivelyApplied: Settlement.isUndoResultEffectivelyApplied,
    async callPageBridge(method, params) {
      state.requests.push({ method, params });
      if (method === 'applyOperations') {
        state.checkpointAtDelete = state.savedRun && JSON.parse(JSON.stringify(state.savedRun));
      }
      const guard = WriteGuard.create({ window, sleep: async () => {} });
      return await guard.runWriteGuard(params) || await router[method](params);
    }
  };
  vm.createContext(context);
  for (const name of ['getRunUndoCount', 'recordUndoFromApply', 'undoRun', 'undoRunTrackedChanges',
    'applyTrackedChangeSettlement', 'applyLegacyUndoSettlement']) vm.runInContext(extract(name), context);
  if (runtime.includes('  function advanceRunUndoProgress(')) vm.runInContext(extract('advanceRunUndoProgress'), context);
  const nativeCapture = NativeCapture.create({ getCodeMirrorEditorView: () => views.get(state.activePath),
    getTrackedChangeDocumentId: target => docs.get(target)?.id || '',
    getActiveFilePath: () => state.activePath, readActiveEditorText: () => docs.get(state.activePath)?.content,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath });
  context.recordUndoFromApply(project, { applied: operations.map(operation => ({ operation, result: { ok: true,
    ...(operation.type === 'edit' ? { verifiedContent: operation.verifiedContent } : {}) } })),
    trackedChanges: options.mixed && options.track !== false ? nativeCapture.prepareTrackedChangeCapture('main.tex').refs : [] });
  return { docs, run, state, router, context, undo: () => context.undoRun(run.id) };
}

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
