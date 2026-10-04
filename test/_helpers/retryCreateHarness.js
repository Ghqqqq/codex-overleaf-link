'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const crypto = require('node:crypto');
const repo = path.resolve(__dirname, '../..');
const req = file => require(path.join(repo, file));
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const { extractFunction } = req('test/_helpers/extractFunction.js');
const Undo = req('extension/src/shared/undoOperations.js');
const { fixture } = require('./textFileCreatorFixture');
const Router = req('extension/src/page/writebackRouter.js');
const Journal = req('extension/src/page/writebackReceiptJournal.js');
const Broker = req('extension/src/content/assetTransferBroker.js');
const Controller = req('extension/src/content/writebackController.js');
const Plan = req('extension/src/content/writebackPlan.js');
const ProjectFiles = req('extension/src/shared/projectFiles.js');
const Governance = req('extension/src/shared/governanceRules.js');
const Settlement = req('extension/src/shared/writebackSettlement.js');
const WritebackIntent = req('extension/src/shared/writebackIntent.js');
const SessionState = req('extension/src/shared/sessionState.js');
const StaleGuard = req('extension/src/shared/staleGuard.js');
const WriteGuard = req('extension/src/page/writeGuard.js');
const Verification = req('extension/src/content/writebackVerificationController.js');
const Storage = req('extension/src/shared/storageDb.js');
const runtimeSource = read('extension/src/content/contentRuntime.js');
const pageSource = read('extension/src/pageBridge.js');
const orchestratorSource = read('extension/src/content/writebackOrchestrator.js');
const clone = value => JSON.parse(JSON.stringify(value));
const tx = en => en, tr = key => key, noop = () => {};
const getAppliedEntries = result => Array.isArray(result?.applied) ? result.applied : [];
const getSkippedEntries = result => Array.isArray(result?.skipped) ? result.skipped : [];
const owner = { projectId: 'example', accountScopeId: 'fixture-account', sessionId: 'fixture-session', runId: 'fixture-run' };
function createHarness({ existing, pending = true, zipOptions = {}, content = '% retry create fixture\n' } = {}) {
  const op = { type: 'create', path: 'retry-probe.tex', content };
  const fixtureOptions = { initialFiles: existing === undefined ? {} : { [op.path]: existing }, ...zipOptions };
  const f = fixture(fixtureOptions);
  const trace = [], applications = [], toasts = [], finishes = [], persisted = [];
  const win = { _ide: { project: { _id: owner.projectId } }, document: {}, CodexOverleafStaleGuard: StaleGuard,
    CodexOverleafWriteGuard: WriteGuard };
  const rawRouter = Router.create({ window: win, treeOperations: f.treeOperations,
    normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    createTextFile(operation, options) { trace.push({ layer: 'creator', allowExistingMatches: options.allowExistingMatches }); return f.creator.createFile(operation, options); },
    beginTextCreateBatch: f.creator.beginCreateBatch, finishTextCreateBatch: f.creator.finishCreateBatch,
    ensureEditing: async () => ({ ok: true }), ensureReviewing: async () => ({ ok: true }),
    delay: async () => {}, writebackOpenSettleMs: 0 });
  const router = { applyOperations(ops, options) {
    trace.push({ layer: 'router', retryCreatesPresent: Object.hasOwn(options || {}, 'retryCreates'), retryCreates: options?.retryCreates ?? null });
    return rawRouter.applyOperations(ops, options);
  } };
  const pageWrapper = vm.runInNewContext('(' + extractFunction(pageSource, 'applyOperations') + ')', { writebackRouter: router });
  const journal = Journal.create({ getProjectId: () => owner.projectId, prepareEditor: async () => ({ ok: true }),
    applyOperations: pageWrapper });
  let request = 0, lastDispatch = null;
  const callPageBridge = async (method, params = {}) => {
    if (method === 'applyOperations') {
      trace.push({ layer: 'pageRpc', retryCreatesPresent: Object.hasOwn(params, 'retryCreates'), retryCreates: params.retryCreates });
      // The production page message handler assigns its dispatch message id here (pageBridge.js:188).
      lastDispatch = { ...params, writebackRequestId: 'fixture-request-' + (++request) };
      return journal.apply(lastDispatch);
    }
    if (method === 'getWritebackReceipt') return journal.get(params);
    if (method === 'invalidateProjectSnapshot') return { ok: true };
    if (method === 'waitForSaveState') return { ok: true, state: 'verified_saved' };
    if (method === 'getProjectSnapshot') return { id: owner.projectId, files: Array.from(f.files, ([path, content]) => ({ path, content })), capabilities: { fullProjectSnapshot: true } };
    throw new Error('Unexpected Page RPC: ' + method);
  };
  const sendBackgroundNative = async ({ method }) => {
    assert.ok(['mirror.invalidate', 'mirror.sync', 'mirror.confirmWriteback'].includes(method));
    return { ok: true, result: { ok: true, invalidated: true } };
  };
  const broker = Broker.create({ callPageBridge, sendBackgroundNative });
  const record = { id: owner.runId, status: 'failed', runProjectId: owner.projectId, events: [] };
  if (pending) record.retryWriteback = { ...owner, id: 'fixture-recovery', operations: [clone(op)], baseFiles: [], requireReviewing: false };
  const session = { id: owner.sessionId, runs: [record] }, state = { mode: 'auto', requireReviewing: false, autoRecompile: false };
  const durableRows = new Map();
  const runtime = vm.createContext({ Modules: { WritebackIntent, SessionState, UndoOperations: Undo,
      WritebackVerificationController: Verification, StorageDb: { ...Storage, getRecord: async (_store, id) => clone(durableRows.get(id)) } }, WritebackSettlement: Settlement,
    spaRouteGeneration: 0, writebackVerificationController: null, updateIdleClient: null,
    crypto, AbortController, TextEncoder, Date, console, state, currentRunView: null,
    trackedChangeInFlight: new Set(), cachedAccountScopeId: owner.accountScopeId,
    runCancellationRequested: false, runCancellationController: null,
    getActiveSession: () => session, getCurrentProjectId: () => owner.projectId,
    findRunRecord: (id, sid) => id === record.id && sid === session.id ? record : null,
    panel: { querySelector: () => null }, cssEscape: x => x, renderRunHistory: noop, setRunning: noop,
    showPluginToast: text => toasts.push(text), tx, tr, callPageBridge, writebackController: Controller,
    getAppliedEntries, getSkippedEntries,
    attachVerifiedContentToOperation: Settlement.attachVerifiedContentToOperation,
    normalizeApplyTrackedChanges: Settlement.normalizeApplyTrackedChanges,
    selectExpectedFilesForTrackedUndo: Settlement.selectExpectedFilesForTrackedUndo,
    buildCreatedFileUndoCheckpoint: Undo.buildCreatedFileUndoCheckpoint, buildUndoCheckpoint: Undo.buildUndoCheckpoint,
    refreshRunCardControls: noop, appendRunEvent: noop, formatOperationType: x => x,
    flushQueuedSaveState: async () => {
      persisted.push(clone(record));
      durableRows.set(session.id, Storage.buildSessionRecord({ ...clone(session), projectId: owner.projectId, accountScopeId: owner.accountScopeId }, { preserveRunActionPayload: true }));
      return true;
    }, saveStateSoon: noop,
    finishRunView: async (label, status) => { record.status = status; finishes.push({ label, status }); } });
  for (const name of ['recoveryOwner', 'getWritebackVerificationController', 'stageWritebackRecovery', 'settleWritebackRecovery', 'retryRunWriteback', 'recordUndoFromApply']) {
    vm.runInContext(extractFunction(runtimeSource, name), runtime, { filename: 'contentRuntime.js#' + name });
  }
  const plan = Plan.create({ tx, tr, normalizeSafeProjectPath: ProjectFiles.normalizeSafeProjectPath,
    GovernanceRules: Governance, getGovernanceRulesForCurrentProject: () => ({}), showPluginConfirm: async () => true,
    formatOperationFiles: () => '', getAppliedEntries, getSkippedEntries });
  const orchestratorModule = new Function('window', orchestratorSource + '\nreturn window.CodexOverleafWritebackOrchestrator;')({});
  const orchestrator = orchestratorModule.create({
    ...plan, tr, tx, getLocale: () => 'en', getState: () => state, getCurrentRunView: () => runtime.currentRunView,
    getCurrentProjectId: () => owner.projectId, getAssistantAnswerForCurrentRun: () => 'fixture answer', cleanFinalAnswer: x => x,
    appendRunEvent: noop, appendRunRecordEvent: noop, appendChangeSummary: () => 'summary',
    appendCompletionReport: noop, appendOperationsPreview: noop, appendPartialWritebackWarning: noop,
    appendApplyResult: value => applications.push(clone(value)), renderReadOnlyDiffReview: noop, showPluginConfirm: async () => true,
    ensureReviewingBeforeWrite: async () => ({ ok: true }), recordUndoFromApply: (...args) => runtime.recordUndoFromApply(...args),
    stageWritebackRecovery: (...args) => runtime.stageWritebackRecovery(...args),
    settleWritebackRecovery: (...args) => runtime.settleWritebackRecovery(...args),
    assetTransferBroker: broker, callPageBridge, sendBackgroundNative, writebackController: Controller, writebackSettlement: Settlement,
    buildSyncApplyOperations: Controller.buildSyncApplyOperations, getAppliedOperationPaths: Controller.getAppliedOperationPaths,
    getAppliedSyncChanges: Controller.getAppliedSyncChanges, getSkippedEntries,
    hasApplyResultEntries: value => getAppliedEntries(value).length + getSkippedEntries(value).length > 0,
    hasSkippedApplyOperations: values => values.some(value => getSkippedEntries(value).length),
    formatWritebackSkippedNextStep: () => 'review skipped', resetContextProject: noop, sanitizeRunProjectSnapshot: x => x,
    RUN_SNAPSHOT_ZIP_TIMEOUT_MS: 30000
  });
  runtime.applySyncChangesToOverleaf = (...args) => {
    trace.push({ layer: 'orchestrator', retryCreatesPresent: Object.hasOwn(args[2], 'retryCreates'), retryCreates: args[2].retryCreates ?? null });
    return orchestrator.applySyncChangesToOverleaf(...args);
  };
  return { op, f, fixtureOptions, runtime, record, trace, applications, finishes, toasts, persisted,
    async duplicateOriginalRequest() { return journal.apply(lastDispatch); },
    async retry() { await runtime.retryRunWriteback(record.id); await orchestrator.getPendingMirrorRefresh(); assert.deepEqual(toasts, []); return applications.at(-1); },
    async direct(retryCreates) { return router.applyOperations([clone(op)], { runProjectId: owner.projectId, retryCreates, baseFiles: [], requireEditing: true }); },
    async initialCreate() {
      runtime.currentRunView = { recordId: record.id, sessionId: session.id, runProjectId: owner.projectId };
      const result = await orchestrator.applySyncChangesToOverleaf([clone(op)], { id: owner.projectId, files: [{ path: 'main.tex', content: 'Existing document' }] }, { mode: 'auto', requireReviewing: false, autoRecompile: false });
      await orchestrator.getPendingMirrorRefresh(); runtime.currentRunView = null; return result.applied;
    }
  };
}

module.exports = { createHarness };
