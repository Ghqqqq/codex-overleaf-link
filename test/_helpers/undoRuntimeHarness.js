'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const Undo = require('../../extension/src/shared/undoOperations');
const Settlement = require('../../extension/src/shared/writebackSettlement');
const Router = require('../../extension/src/page/writebackRouter');
const StaleGuard = require('../../extension/src/shared/staleGuard');
const WriteGuard = require('../../extension/src/page/writeGuard');
const ProjectFiles = require('../../extension/src/shared/projectFiles');
const Capture = require('../../extension/src/content/trackedChangeCaptureController');
const Storage = require('../../extension/src/shared/storageDb');
const Session = require('../../extension/src/shared/sessionState');
const Actions = require('../../extension/src/content/runResultActions');
const NativeCapture = require('../../extension/src/page/trackedChangeCapture');
const Lifecycle = require('../../extension/src/page/trackedChangesLifecycle');
const Scope = require('../../extension/src/content/scopedPersistencePanelState');
const FailureReasons = require('../../extension/src/shared/failureReasons');
const ReviewController = require('../../extension/src/content/runReviewController');
const runtime = fs.readFileSync(path.join(__dirname, '../../extension/src/content/contentRuntime.js'), 'utf8');
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
  const project = { id: 'qa-project', files: options.files || [{ path: 'main.tex', content: 'before\n' }] };
  const docs = new Map(project.files.map(file => [file.path, { ...file }]));
  const operations = options.operations || [...(options.mixed ? [{ type: 'edit', path: 'main.tex', replaceAll: 'before\n% mixed\n', verifiedContent: 'before\n% mixed\n' }] : []), ...createOperations()];
  for (const op of operations) {
    if (op.type === 'delete') { docs.delete(op.path); continue; }
    docs.set(op.path, op.type === 'binary-create'
    ? { path: op.path, contentBase64: image.toString('base64') }
    : { path: op.path, content: op.replaceAll ?? op.content });
  }
  const state = { projectId: project.id, activePath: 'main.tex', reviewing: options.track !== false,
    requests: [], results: [], createAttempts: [], created: [], removed: [], events: [], prompts: [] };
  const run = { id: 'created-run', task: 'Disposable files', mode: 'auto', status: 'completed',
    runProjectId: project.id, executionSnapshot: { requireReviewing: options.track !== false, source: 'submitted' },
    appliedOperations: [], undoOperations: [], undoBaseFiles: [], undoExpectedFiles: [], undoTrackedChanges: [] };
  const capture = Capture.create({ buildExpectedFilesAfterOperations: Undo.buildExpectedFilesAfterOperations });
  for (const file of docs.values()) {
    file.id = 'doc-' + file.path;
    file.before = project.files.find(original => original.path === file.path)?.content;
    file.changes = operations.some(op => op.type === 'edit' && op.path === file.path) && options.track !== false
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
  const router = (options.createRouter || Router.create)({ window, writebackOpenSettleMs: 0,
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
    async createTextFile(operation, config) {
      state.createAttempts.push(operation.path);
      if (!config.isCurrent()) return { ok: false, code: 'aborted_project_changed' };
      if (options.failCreate && !state.createFailed && (!options.failCreatePath || operation.path === options.failCreatePath)) {
        state.createFailed = true; return { ok: false, code: 'file_tree_controls_unavailable', changedDocument: false };
      }
      if (docs.has(operation.path)) return { ok: false, code: 'path_created_since_snapshot', changedDocument: false };
      docs.set(operation.path, { path: operation.path, content: operation.content }); state.created.push(operation.path);
      return { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: true };
    },
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
    getPageBridgeTimeoutMs: () => 120000,
    WritebackSettlement: Settlement, buildContentFailure: (code, details) => ({ code, ...details }),
    writebackOrchestrator: { invalidateMirrorAfterUndo() {} },
    isUndoResultEffectivelyApplied: Settlement.isUndoResultEffectivelyApplied,
    async callPageBridge(method, params) {
      state.requests.push({ method, params });
      if (method === 'applyOperations') {
        state.checkpointAtDelete = state.savedRun && JSON.parse(JSON.stringify(state.savedRun));
      }
      const guard = WriteGuard.create({ window, sleep: async () => {} });
      const result = await guard.runWriteGuard(params) || await router[method](params);
      state.results.push(result); return result;
    }
  };
  context.getDirectoryCleanupRecovery = () => require('../../extension/src/content/directoryCleanupRecovery').create({
    getProjectId: () => state.projectId, getAccountScopeId: () => 'account-one', getState: () => context.state,
    getRouteGeneration: () => 0, findRunRecord: () => run, refresh() {}
  });
  vm.createContext(context);
  let reviewController;
  context.getRunReviewController = () => reviewController || (reviewController = ReviewController.create({ ...context,
    getState: () => context.state }));
  for (const name of ['getRunUndoCount', 'recordUndoFromApply', 'undoRun', 'undoRunTrackedChanges',
    'applyTrackedChangeSettlement', 'applyLegacyUndoSettlement']) vm.runInContext(extract(name), context);
  if (runtime.includes('  function advanceRunUndoProgress(')) vm.runInContext(extract('advanceRunUndoProgress'), context);
  const nativeCapture = NativeCapture.create({ getCodeMirrorEditorView: () => views.get(state.activePath),
    getTrackedChangeDocumentId: target => docs.get(target)?.id || '',
    getActiveFilePath: () => state.activePath, readActiveEditorText: () => docs.get(state.activePath)?.content,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath });
  context.recordUndoFromApply(project, { applied: operations.map(operation => ({ operation, result: { ok: true,
    ...(operation.type === 'edit' ? { verifiedContent: operation.verifiedContent } : {}) } })),
    trackedChanges: docs.has('main.tex') && operations.some(op => op.type === 'edit') && options.track !== false ? nativeCapture.prepareTrackedChangeCapture('main.tex').refs : [] });
  return { docs, run, state, router, context, undo: () => context.undoRun(run.id) };
}

module.exports = { harness, image, digest };
