'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { root, plain } = require('./nativeReviewHarness.js');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const Settlement = require(path.join(root, 'extension/src/shared/writebackSettlement'));
const Scope = require(path.join(root, 'extension/src/content/scopedPersistencePanelState'));
const Undo = require(path.join(root, 'extension/src/shared/undoOperations'));
const CaptureController = require(path.join(root, 'extension/src/content/trackedChangeCaptureController'));
const Db = require(path.join(root, 'extension/src/shared/storageDb'));
const I18n = require(path.join(root, 'extension/src/shared/i18n'));
const FailureReasons = require(path.join(root, 'extension/src/shared/failureReasons'));
const ResultActions = require(path.join(root, 'extension/src/content/runResultActions'));
const Sessions = require(path.join(root, 'extension/src/content/sessionPersistence'));
const State = require(path.join(root, 'extension/src/shared/sessionState'));
const Proof = require(path.join(root, 'extension/src/shared/manualReviewProof'));
const ReviewController = require(path.join(root, 'extension/src/content/runReviewController'));
const PageRpcContract = require(path.join(root, 'extension/src/shared/pageRpcContract'));
const runtime = fs.readFileSync(path.join(root, 'extension/src/content/contentRuntime.js'), 'utf8');
const timeline = fs.readFileSync(path.join(root, 'extension/src/content/runTimelineView.js'), 'utf8');
const tr = (key, values) => I18n.t('en', key, values);
function buttons(run, options = {}) {
  const current = {};
  function element(selector) {
    return { hidden: false, disabled: false, textContent: '', title: '',
      cloneNode: () => element(selector), replaceWith(value) { current[selector] = value; }, addEventListener() {} };
  }
  current['[data-run-undo]'] = element('[data-run-undo]');
  current['[data-run-accept]'] = element('[data-run-accept]');
  const context = vm.createContext({ tr, tx: value => value, trackedChangeInFlight: options.trackedChangeInFlight || new Map(),
    projectRunSettlement: Settlement.projectRunSettlement, RunResultActions: ResultActions.create({}),
    undoRun() {}, wireAcceptInlineConfirm() {} });
  for (const name of ['isTrackedChangeLifecycleRun','configureUndoButton','configureLifecycleUndoButton','configureAcceptButton']) {
    vm.runInContext(extractFunction(timeline, name), context);
  }
  const rootNode = { querySelector: selector => current[selector], querySelectorAll: () => [] };
  context.configureUndoButton(rootNode, run); context.configureAcceptButton(rootNode, run);
  return Object.fromEntries(Object.entries(current).map(([selector, value]) => [selector.includes('undo') ? 'undo' : 'accept',
    { hidden: value.hidden, disabled: value.disabled, text: value.textContent, title: value.title }]));
}
function acceptController(page, params) {
  let run = { id: 'accept-run', task: 'Synthetic acceptance', status: 'completed', mode: 'auto',
    runProjectId: params.runProjectId, trackedChangeStatus: 'pending', undoStatus: 'ready',
    executionSnapshot: { requireReviewing: true, source: 'submitted' },
    undoTrackedChanges: plain(params.trackedChanges), undoExpectedFiles: plain(params.expectedFiles), undoOperations: [], undoBaseFiles: [],
    appliedOperations: params.postFiles.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })), events: [] };
  let state = { runs: [run], activeSessionId: 'review-session', sessions: [{ id: 'review-session', accountScopeId: 'account-one', projectId: params.runProjectId, runs: [run] }] };
  const events = [], saved = [], rows = [];
  const storage = { ...Db,
    getAllByIndex: async () => plain(rows),
    async putRecords(_store, records) { rows.splice(0, rows.length, ...plain(records)); saved.push(...plain(records)); return plain(records); }
  };
  const migration = { loadPrefs: async () => ({}), savePrefs: async () => {},
    loadSessionTombstones: async () => ({}), getDeletedSessionIds: () => [] };
  const capture = CaptureController.create({ buildExpectedFilesAfterOperations: Undo.buildExpectedFilesAfterOperations });
  const context = vm.createContext({ state, Modules: { ScopedPersistenceCoordinator: Scope, UndoOperations: Undo, ManualReviewProof: Proof },
    WritebackSettlement: Settlement, FailureReasons, trackedChangeInFlight: new Map(), tr, tx: en => en, notify() {},
    getCurrentProjectId: () => page.state.projectId, getAccountScopeId: () => 'account-one', getRouteGeneration: () => 0,
    findRunRecord: () => run, refreshRunCardControls() {},
    appendRunRecordEvent(_id, event) { events.push(plain(event)); run.events.push(plain(event)); },
    formatTrackedChangeFiles: refs => refs.map(ref => ref.path).join(', '),
    formatBridgeResultReason: result => result.reason || result.code || '',
    buildTrackedUndoPostFiles: record => capture.buildPostFiles(record),
    getPageBridgeTimeoutMs: method => PageRpcContract.resolveTimeoutMs(method),
    callPageBridge: (method, payload) => page.rpc(method, payload),
    async flushQueuedSaveState(options) {
      return Scope.persistPanelState({ state, compactState: State.prepareStateForStorage(state), projectId: params.runProjectId,
        Migration: migration, StorageDb: storage, SessionPersistence: Sessions, reviewRunIds: options?.reviewRunIds,
        normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
        normalizeCustomInstructionsByProject: value => value || {},
        persistenceContext: { scope: { accountScopeId: 'account-one', projectId: params.runProjectId }, nextMeta: {} } });
    }
  });
  vm.runInContext(extractFunction(timeline, 'isTrackedChangeLifecycleRun'), context);
  let controller;
  context.getRunReviewController = () => controller || (controller = ReviewController.create({ ...context, getState: () => state }));
  for (const name of ['acceptRun','openManualReviewFile','verifyManualReview','getRunProjectIdForWriteback','buildContentFailure','applyTrackedChangeSettlement']) {
    vm.runInContext(extractFunction(runtime, name), context);
  }
  return { get run() { return run; }, events, saved, context, storage,
    reload() { const Session = require(path.join(root, 'extension/src/shared/sessionState'));
      state = context.state = { ...state, sessions: [plain(saved.at(-1))] };
      run = Session.normalizeRuns(state.sessions[0].runs, { restoreRunningRuns: true })[0];
      state.sessions[0].runs = [run]; state.runs = [run]; },
    verify: () => context.verifyManualReview(run.id), open: path => context.openManualReviewFile(run.id, path), accept: () => context.acceptRun(run.id), buttons: () => buttons(run) };
}
module.exports = { root, plain, runtime, timeline, Settlement, Scope, Undo, Db, tr, buttons, acceptController };
