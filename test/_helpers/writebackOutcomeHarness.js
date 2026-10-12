'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const req = file => require(path.join(root, file));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { extractFunction } = req('test/_helpers/extractFunction');
const { harness } = req('test/_helpers/runSubmissionHarness');
const { fixture } = req('test/_helpers/textFileCreatorFixture');
const Router = req('extension/src/page/writebackRouter');
const Journal = req('extension/src/page/writebackReceiptJournal');
const Broker = req('extension/src/content/assetTransferBroker');
const Controller = req('extension/src/content/writebackController');
const Plan = req('extension/src/content/writebackPlan');
const Storage = req('extension/src/shared/storageDb');
const ProjectFiles = req('extension/src/shared/projectFiles');
const Governance = req('extension/src/shared/governanceRules');
const Settlement = req('extension/src/shared/writebackSettlement');
const Persistence = req('extension/src/content/runSettlementPersistence');
const Intent = req('extension/src/shared/writebackIntent');
const ActiveTurnControl = req('extension/src/content/activeTurnControl');
const Session = req('extension/src/shared/sessionState');
const Undo = req('extension/src/shared/undoOperations');
const Transcript = req('extension/src/shared/agentTranscript');
const Activity = req('extension/src/shared/runActivityModel');
const Compile = req('extension/src/shared/compileAdapter');
const StaleGuard = req('extension/src/shared/staleGuard');
const WriteGuard = req('extension/src/page/writeGuard');
const I18n = req('extension/src/shared/i18n');
const Failure = req('extension/src/shared/failureReasons');
const Summary = req('extension/src/shared/summary');
const runtime = read('extension/src/content/contentRuntime.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const no = () => {};
const appliedEntries = result => Array.isArray(result?.applied) ? result.applied : [];
const skippedEntries = result => Array.isArray(result?.skipped) ? result.skipped : [];

function createFlow(options = {}) {
  const h = harness(), c = h.context;
  // Use the production owner controller for Retry; only Chrome's port transport
  // is synthetic, and acknowledges the exact binding sent by that controller.
  c.activeTurnControl = ActiveTurnControl.create({ chrome: { runtime: { connect() {
    let receive;
    return { onMessage: { addListener: fn => { receive = fn; } }, onDisconnect: { addListener: no },
      postMessage(message) { if (message.type === 'bind') receive?.({ ...message, type: 'bound' }); }, disconnect: no };
  } } } });
  const trace = [], brokerResults = [], summaries = [], applications = [], reportInputs = [], toasts = [];
  const config = { editNoMutation: false, truncateReceipt: false, rawBrokerBypass: false,
    saveUnknown: false, snapshotUnavailable: false, ...options };
  const creatorOptions = { ...(options.creatorOptions || {}), initialFiles: options.initialFiles || {} };
  const f = fixture(creatorOptions); let activePath = 'main.tex';
  const projectId = 'example';
  c.getCurrentProjectId = () => projectId; c.activeProjectId = projectId;
  c.window.location.pathname = '/project/' + projectId;
  c.cachedAccountScopeId = 'account-one';
  c.state.mode = 'auto'; h.controls.get('[data-mode]').value = 'auto';
  c.state.requireReviewing = false; h.controls.get('[data-require-reviewing]').checked = false;
  c.state.autoRecompile = options.autoRecompile === true; h.controls.get('[data-auto-recompile]').checked = c.state.autoRecompile;
  c.readPanelInputs();
  const tree = { ...f.treeOperations, getActiveFilePath: () => activePath,
    async openFileByPath(file, params) { activePath = file; return f.treeOperations.openFileByPath(file, params); } };
  const writeText = text => {
    const noMutation = config.editNoMutation || config.editNoMutationPaths?.includes(activePath);
    trace.push({ kind: 'editor-dispatch', path: activePath, noMutation: Boolean(noMutation) });
    if (!noMutation) f.files.set(activePath, text);
    return { ok: true, method: 'synthetic-editor-dispatch' };
  };
  const router = Router.create({
    window: { _ide: { project: { _id: projectId } }, document: {}, CodexOverleafStaleGuard: StaleGuard, CodexOverleafWriteGuard: WriteGuard },
    treeOperations: tree, normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    createTextFile: (operation, params) => f.creator.createFile(operation, params),
    beginTextCreateBatch: f.creator.beginCreateBatch, finishTextCreateBatch: f.creator.finishCreateBatch,
    readActiveEditorText: () => f.files.get(activePath) || '', getActiveEditorIdentity: () => ({ path: activePath }),
    activeEditorIdentityChanged: () => true, replaceActiveEditorText: writeText,
    replaceActiveEditorPatches: (_patches, next) => writeText(next),
    ensureEditing: async () => ({ ok: true }), ensureReviewing: async () => ({ ok: true }),
    delay: async () => {}, writebackOpenSettleMs: 0, writeVerifyWaitMs: 0
  });
  const pageApply = vm.runInNewContext('(' + extractFunction(read('extension/src/pageBridge.js'), 'applyOperations') + ')', { writebackRouter: router });
  const journal = Journal.create({ getProjectId: () => projectId, prepareEditor: async () => ({ ok: true }), applyOperations: pageApply });
  let request = 0;
  const snapshot = () => ({ id: projectId, activePath: 'main.tex', files: [...f.files].map(([path, content]) => ({ path, content })), capabilities: { fullProjectSnapshot: true } });
  const callPageBridge = async (method, params = {}) => {
    trace.push({ kind: 'page', method, params: clone(params) });
    if (method === 'applyOperations') {
      const result = await journal.apply({ ...params, writebackRequestId: 'write-' + (++request) });
      trace.push({ kind: 'page-produced', result: clone(result) });
      if (config.truncateReceipt) {
        const truncated = { ...result, ok: true, applied: result.applied.slice(0, 1), skipped: [] };
        trace.push({ kind: 'transport-fault-truncated', result: clone(truncated) }); return truncated;
      }
      return result;
    }
    if (method === 'getWritebackReceipt') return journal.get(params);
    if (method === 'waitForSaveState') return config.saveUnknown ? { ok: false, state: 'unknown_timeout' } : { ok: true, state: 'verified_saved' };
    if (method === 'invalidateProjectSnapshot') return { ok: true };
    if (method === 'getProjectSnapshot') {
      if (config.snapshotUnavailable) throw new Error('Synthetic server snapshot unavailable');
      return snapshot();
    }
    if (method === 'triggerCompile') return { ok: true, compile: { status: 'success' } };
    if (method === 'getCompileLog') return { ok: true, errors: [], warnings: [], log: 'synthetic successful compile' };
    if (method === 'jumpToPosition') return { ok: true };
    throw new Error('Unexpected Page method: ' + method);
  };
  const native = async request => {
    trace.push({ kind: 'native-background', method: request.method });
    assert.ok(['mirror.invalidate', 'mirror.sync', 'mirror.confirmWriteback'].includes(request.method));
    return { ok: true, result: { ok: true, invalidated: true } };
  };
  const realBroker = Broker.create({ callPageBridge, sendBackgroundNative: native, delay: async () => {} });
  const broker = { async applyOperations(input) {
    const result = await realBroker.applyOperations(input);
    brokerResults.push(clone(result)); return result;
  } };
  Object.assign(c, {
    crypto: require('node:crypto').webcrypto, TextEncoder,
    getRunProjectSnapshot: async () => snapshot(),
    getLocale: () => 'en', tr: (key, params) => I18n.t('en', key, params), tx: en => en,
    appendPlainLog: value => trace.push({ kind: 'plain-log', text: String(value) }), showPluginToast: value => toasts.push(String(value)),
    buildHumanCompletionReport: Transcript.buildHumanCompletionReport, getRunUndoCount: run => (run?.undoOperations || []).length,
    MAX_RUN_EVENTS: 300, lastRunActivityBumpMs: 0, scheduleRunStateSave: no,
    callPageBridge, writebackController: Controller, getAppliedEntries: appliedEntries, getSkippedEntries: skippedEntries,
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint, buildUndoCheckpoint: Undo.buildUndoCheckpoint,
    refreshRunCardControls: no, formatOperationType: value => value, cssEscape: value => value,
    trackedChangeInFlight: new Set()
  });
  const durableRows = new Map();
  const originalFlush = c.flushQueuedSaveState;
  c.flushQueuedSaveState = async options => {
    await originalFlush(options);
    for (const session of c.state.sessions) durableRows.set(session.id, Storage.buildSessionRecord({
      ...clone(session), projectId, accountScopeId: c.cachedAccountScopeId
    }, { preserveRunActionPayload: true }));
    return true;
  };
  c.spaRouteGeneration = 0; c.directoryCleanupRecovery = null;
  Object.assign(c.Modules, { SessionState: Session, UndoOperations: Undo, WritebackIntent: Intent, RunActivityModel: Activity,
    DirectoryCleanupRecovery: req('extension/src/content/directoryCleanupRecovery'),
    StorageDb: { ...Storage, getRecord: async (_store, id) => clone(durableRows.get(id)) } });
  for (const name of ['appendRunEvent', 'appendCompletionReport', 'recoveryOwner', 'getDirectoryCleanupRecovery', 'stageWritebackRecovery',
    'settleWritebackRecovery', 'retryRunWriteback', 'recordUndoFromApply', 'prepareRetryReplacement']) {
    vm.runInContext(extractFunction(runtime, name), c, { filename: 'runtime#' + name });
  }
  c.runSettlementPersistence = Persistence.create({ writebackSettlement: Settlement,
    getCurrentRunView: () => c.currentRunView, findRunRecord: (...args) => c.findRunRecord(...args),
    getCurrentProjectId: () => projectId, saveStateSoon: no });
  const applyFormatters = new Function('window', read('extension/src/content/applyResultFormatters.js')
    + '\nreturn window.CodexOverleafApplyResultFormatters;')({}).create({
    i18n: I18n, FailureReasons: Failure, getLocale: c.getLocale, tr: c.tr, tx: c.tx,
    getAppliedEntries: appliedEntries, getSkippedEntries: skippedEntries, appendRunEvent: (...args) => c.appendRunEvent(...args)
  });
  const plan = Plan.create({ tx: c.tx, tr: c.tr, normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => options.governance || {},
    showPluginConfirm: async () => options.confirm !== false, formatOperationFiles: operations => operations.map(op => op.path).join(', '),
    getAppliedEntries: appliedEntries, getSkippedEntries: skippedEntries });
  // Keep the orchestrator and injected CommonJS modules in one Function realm:
  // its real `settle instanceof Function` check must see the production method.
  const orchestratorModule = new Function('window', read('extension/src/content/writebackOrchestrator.js')
    + '\nreturn window.CodexOverleafWritebackOrchestrator;')({});
  const orchestrator = orchestratorModule.create({ ...plan,
    tr: c.tr, tx: c.tx, getLocale: c.getLocale, getState: () => c.state, getCurrentRunView: () => c.currentRunView,
    getCurrentProjectId: () => projectId, getAssistantAnswerForCurrentRun: () => 'Synthetic model result', cleanFinalAnswer: value => value,
    appendRunEvent: (...args) => c.appendRunEvent(...args), appendRunRecordEvent: no,
    appendChangeSummary: input => { const text = Summary.buildChangeSummaryLine(input); summaries.push({ input: clone(input), text }); return text; },
    appendCompletionReport: input => { reportInputs.push(clone(input)); c.appendCompletionReport(input); },
    appendOperationsPreview: no, appendPartialWritebackWarning: no,
    appendApplyResult: value => { applications.push(clone(value)); applyFormatters.appendApplyResult(value); },
    renderReadOnlyDiffReview: no, showPluginConfirm: async () => options.confirm !== false,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), recordUndoFromApply: (...args) => c.recordUndoFromApply(...args),
    stageWritebackRecovery: (...args) => c.stageWritebackRecovery(...args), settleWritebackRecovery: (...args) => c.settleWritebackRecovery(...args),
    assetTransferBroker: broker, callPageBridge, sendBackgroundNative: native, writebackController: Controller, writebackSettlement: Settlement,
    compileAdapter: Compile, buildSyncApplyOperations: Controller.buildSyncApplyOperations,
    formatOperationFiles: operations => operations.map(operation => operation.path).join(', '),
    getAppliedOperationPaths: Controller.getAppliedOperationPaths, getAppliedSyncChanges: Controller.getAppliedSyncChanges,
    getSkippedEntries: skippedEntries, hasApplyResultEntries: value => appliedEntries(value).length + skippedEntries(value).length > 0,
    hasSkippedApplyOperations: values => values.some(value => skippedEntries(value).length),
    formatWritebackSkippedNextStep: () => 'Review the skipped operation.', resetContextProject: no, sanitizeRunProjectSnapshot: value => value,
    onMirrorRefreshSettled: value => c.runSettlementPersistence.settleMirrorRefresh(value), RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000
  });
  c.applySyncChangesToOverleaf = (...args) => { trace.push({ kind: 'orchestrator-options', options: clone(args[2]) }); return orchestrator.applySyncChangesToOverleaf(...args); };
  c.nativeChannel.sendNativeTracked = request => {
    h.io.requests.push(clone(request.params));
    return { id: 'synthetic-native-task', promise: Promise.resolve({ ok: true, result: { assistantMessage: 'Synthetic model result',
      syncChanges: clone(options.syncChanges || [{ type: 'create', path: 'one.tex', content: 'One synthetic file' }]),
      unsupportedChanges: clone(options.unsupportedChanges || []), threadId: request.params.threadId } }) };
  };
  const getRecord = () => c.state.sessions.find(session => session.id === 'A').runs.at(-1);
  return { h, c, f, config, creatorOptions, trace, brokerResults, summaries, applications, reportInputs, toasts, getRecord,
    async run() { await h.start(); await orchestrator.getPendingMirrorRefresh(); assert.deepEqual(h.io.errors, [], 'unexpected runtime failure'); return getRecord(); },
    async retry() { await c.retryRunWriteback(getRecord().id); await orchestrator.getPendingMirrorRefresh(); return getRecord(); },
    setCompile(value) { c.state.autoRecompile = value; h.controls.get('[data-auto-recompile]').checked = value; },
    compileCalls() { return trace.filter(item => item.kind === 'page' && item.method === 'triggerCompile'); }
  };
}
module.exports = { root, req, read, clone, createFlow, Settlement, Failure, I18n, extractFunction };
