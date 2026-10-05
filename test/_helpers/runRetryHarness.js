'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const SessionState = require(path.join(root, 'extension/src/shared/sessionState'));
const RunExecutionSnapshot = require(path.join(root, 'extension/src/shared/runExecutionSnapshot'));
const runController = require(path.join(root, 'extension/src/content/runController'));
const WritebackSettlement = require(path.join(root, 'extension/src/shared/writebackSettlement'));
const ProjectFiles = require(path.join(root, 'extension/src/shared/projectFiles'));
const runtime = fs.readFileSync(path.join(root, 'extension/src/content/contentRuntime.js'), 'utf8');
const SensitiveScan = require(path.join(root, 'extension/src/shared/sensitiveScan'));
const SensitivePreflight = require(path.join(root, 'extension/src/content/sensitivePreflight'));
const AuditRecords = require(path.join(root, 'extension/src/shared/auditRecords'));
const GovernanceRules = require(path.join(root, 'extension/src/shared/governanceRules'));
const MirrorHealth = require(path.join(root, 'extension/src/content/mirrorHealth'));
const OtWarmMirrorController = require(path.join(root, 'extension/src/content/otWarmMirrorController'));
const MARKER = '-----BEGIN SYNTHETIC PRIVATE KEY-----';
const CLEAN = 'Synthetic manuscript content for deterministic project snapshot validation. '.repeat(4);
function project(content = CLEAN, full = true) { return { id: 'project-one', activePath: 'main.tex', files: [{ path: 'main.tex', kind: 'text', content }], capabilities: { fullProjectSnapshot: full } }; }
const sessionManagerSource = fs.readFileSync(path.join(root, 'extension/src/content/sessionManager.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const no = () => {};
const networkForbidden = async () => { throw new Error('fixture_network_forbidden'); };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function gate() {
  const entered = deferred(), released = deferred(); let used = false;
  return { entered: entered.promise, release: released.resolve,
    async wait(value) { if (!used) { used = true; entered.resolve(); await released.promise; } return value; } };
}
function node(value = '') {
  return { value, checked: false, disabled: false, hidden: true, dataset: {}, title: '',
    options: [{ value: 'high' }], classList: { add: no, remove: no },
    querySelector: () => null, querySelectorAll: () => [], append: no, remove: no, focus: no,
    setAttribute: no, getAttribute: () => '', addEventListener: no };
}
function harness(options = {}) {
  const block = options.block || '';
  const initialProject = options.initialProject || project();
  const retryProject = options.retryProject || project();
  const barrier = gate();
  const io = { audits: [], scans: [], mirrorScans: 0, snapshotReads: 0, reports: [], retryGuards: [], pageCalls: [], backgroundCalls: [], requests: [], stages: [], errors: [], prompts: [], saved: [], cleared: [], events: [], completed: [], binds: [] };
  let projectId = 'project-one', runCounter = 0, pendingRun = null;
  const controls = new Map([
    ['[data-task]', node('task from A')], ['[data-model]', node('fixture-model')],
    ['[data-reasoning]', node('high')], ['[data-speed]', node('standard')], ['[data-mode]', node('ask')],
    ['[data-require-reviewing]', node()], ['[data-auto-recompile]', { ...node(), checked: true }],
    ['[data-log]', node()], ['[data-context-tray]', node()], ['[data-new-session]', node()],
    ['[data-diagnostics-snapshot]', node()]
  ]);
  const panel = { dataset: { view: 'chat' }, querySelector: selector => controls.get(selector) || null,
    querySelectorAll: () => [] };
  const makeSession = (id, task) => ({ id, task, title: id, titleSource: 'manual', mode: 'ask',
    providerId: 'builtin', model: 'fixture-model', reasoningEffort: 'high', speedTier: 'standard',
    requireReviewing: false, codexThreadId: 'thread-' + id, runs: [], history: [] });
  const originalState = SessionState.normalizePanelState({ activeSessionId: 'A',
    sessions: [makeSession('A', 'task from A'), makeSession('B', 'original B draft')],
    mode: 'ask', providerId: 'builtin', model: 'fixture-model', reasoningEffort: 'high', speedTier: 'standard',
    autoRecompile: true, requireReviewing: false });
  const stage = async (name, value) => { io.stages.push(name); return block === name ? barrier.wait(value) : value; };
  const context = {
    state: originalState, panel, currentRunView: null, runSubmissionPending: false, activeProjectId: projectId,
    cachedAccountScopeId: 'account-one', runCancellationRequested: false, runCancellationController: null,
    pendingRetryReplacement: null, composerSkillInvocation: null, composerAttachmentsRestoredOnce: false,
    RunExecutionSnapshot, runController, WritebackSettlement, SensitiveScan, GovernanceRules, AuditRecords, Modules: { ProjectFiles, MirrorHealth, SensitivePreflight, StorageDb: {
      buildAuditLogRecord: AuditRecords.normalizeAuditLogRecord,
      putRecord: async (store, record) => { assert.equal(store, 'auditLogs'); io.audits.push(clone(record)); return record; }
    } },
    AbortController, crypto: webcrypto, fetch: networkForbidden,
    window: { location: { pathname: '/project/project-one', origin: 'https://synthetic.invalid' }, fetch: networkForbidden },
    document: {}, console: { log: no, warn: no, error: (...args) => io.errors.push(args.map(v => String(v?.message || v)).join(' ')) },
    tr: key => key, tx: en => en, getLocale: () => 'en', getCurrentProjectId: () => projectId,
    ...Object.fromEntries(['getActiveSession','updateActiveSession','deriveSessionTitle','recordSessionResult'].map(name => [name, SessionState[name]])),
    updateIdleClient: { isApplying: () => false },
    getPendingMirrorRefresh: () => block === 'mirror' ? stage('mirror', undefined) : null,
    providerSettingsCoordinator: { ensureLoaded: () => stage('provider', undefined),
      getRunSelection: () => ({ providerId: 'builtin' }), getCatalog: () => ({}),
      getProviderSnapshot: () => ({ providerId: 'builtin', providerName: 'Synthetic built-in' }) },
    writingStyleSettings: { ensureLoaded: () => stage('style', undefined), capture: () => null, sync: no },
    selectionContextView: { capture: () => null, clear: no, render: no },
    composerAttachmentController: { getAttachmentsForRun: () => [], serializePersistableAttachments: () => [],
      clear() { io.cleared.push({ activeSessionId: context.state.activeSessionId, taskValue: controls.get('[data-task]').value }); } },
    getComposerDraftPersistence: () => ({ hydrate: no, syncScope: no, changed: no, save: async () => {}, load: async () => [] }),
    getActiveFocusFiles: () => options.focusFiles || [], getCustomInstructionsForCurrentProject: () => '',
    getSkillLoadingSettings: () => ({ loadCodexLocalSkills: false, loadCodexOverleafSkills: false }),
    getComposerAttachmentsForRun: () => [], getComposerSkillInvocationForRun: () => null,
    createRunAttachmentSnapshots: () => [], getEnabledCodexOverleafSkillIds: () => [],
    createRunId: () => 'run-' + (++runCounter), getCurrentProjectReferenceFiles: () => [],
    getLastExperimentalOtProjectId: () => projectId, getThemePreference: () => 'dark', modelSelectHasOption: () => true,
    getRenderedModelEntries: () => [], PANEL_DEFAULT_WIDTH: 400,
    getTrackedChangeCaptureController: () => ({ schedule: no }),
    renderRunCard: () => { const value = node(); value.querySelector = () => node(); return value; },
    saveStateSoon: no, saveState: async () => io.saved.push(clone(context.state)),
    flushQueuedSaveState: async () => io.saved.push(clone(context.state)),
    runGuidanceController: { settleView: no }, getCurrentRunViewForRender: () => null,
    formatProcessedSummary: status => status,
    createAuditDraftForRun: input => stage('audit', { id: 'audit-one', ...input }),
    finalizeAuditRecord: async (draft, outcome) => { io.audits.push(clone(outcome)); }, announceCrossTabRunStart: no,
    appendRunEvent: event => io.events.push(clone(event)), appendLog: no, appendPlainLog: value => io.errors.push(String(value)),
    appendTechnicalEvent: no, appendCompletionReport: value => io.reports.push(clone(value)), formatModeLabel: value => value,
    listSeparator: () => ', ', formatContextItems: paths => paths.join(', '),
    pauseOtWarmMirror: async () => {}, preflightWriteSafety: async () => ({ ok: true }),
    getRunProjectSnapshot: async () => { io.snapshotReads++; return clone(retryProject); },
    formatProjectSnapshotUserLog: () => '', persistCurrentProjectReferenceFiles: no,
    normalizeGovernanceRules: GovernanceRules.normalizeGovernanceRules,
    getGovernanceRulesForCurrentProject: () => options.rules || {},
    updateAuditSensitiveFindings: async (draft, findings) => ({ ...draft, sensitiveFindings: clone(findings) }),
    sendBackgroundNative: async request => {
      io.backgroundCalls.push(request.method);
      if (request.method === 'mirror.status') return { ok: true, result: { exists: true, ageMs: 0 } };
      if (request.method === 'mirror.scanSensitive') { io.mirrorScans++; return { ok: true, result: { findings: [] } }; }
      throw new Error('unexpected_fixture_background_IO:' + request.method);
    },
    callPageBridge: async (method, params) => {
      assert.equal(method, 'getProjectSnapshot'); io.pageCalls.push({ method, params: clone(params) }); return clone(initialProject);
    },
    settleMirrorPrefetchBeforeRun: async () => {},
    hasUsableCodexResult: ({ assistantMessage }) => Boolean(assistantMessage),
    getAssistantAnswerForCurrentRun: () => '',
    applySyncChangesToOverleaf: async (changes, project, options) => {
      assert.equal(options.mode, 'ask'); assert.equal(changes.length, 0);
      return { hasSkippedOperations: false, settlement: {}, audit: {}, applied: { applied: [], skipped: [] } };
    },
    runSettlementPersistence: { applyToCurrentRun: no }, settleRunAfterNavigation: () => null,
    sanitizeAssistantVisibleText: value => value, sanitizeAssistantVisibleValue: value => value,
    nativeCompatibilityController: { ensureForMethod: async () => ({ ok: true, compatibility: {} }), attachEvidence: request => request },
    nativeChannel: { clearActiveRequest: no, sendNativeTracked(request) {
      assert.equal(request.method, 'codex.run'); const params = request.params;
      io.requests.push(clone(params));
      return { id: 'native-request-' + io.requests.length,
        promise: Promise.resolve(options.stale !== false && io.requests.length === 1
          ? { ok: false, error: { code: 'mirror_stale', message: 'Synthetic mirror became stale.' } }
          : { ok: true, result: { assistantMessage: 'Synthetic completed response.', syncChanges: [], threadId: params.threadId } }) };
    } }, activeTurnControl: { bind: binding => io.binds.push(clone(binding)), release: no, acknowledge: async () => {} },
    runQueueScheduler: null, isExperimentalOtEnabled: () => false,
    showPluginConfirm: async prompt => { io.prompts.push(clone(prompt)); return stage('confirm', options.approve === true); }, showPluginToast: no,
    translateRawError: message => { io.errors.push('unexpected-run-error: ' + message); return { conclusion: message, nextStep: '' }; },
    localizeVisibleReason: message => message,
    ...Object.fromEntries(['resetAutoFollow','removeEmptyRunsMessage','scrollLogToBottom','startRunElapsedTick','stopRunElapsedTick',
      'autosizeTaskTextarea','syncComposerSendAvailability','renderComposerSkillInvocation','setExperimentalOtEnabledForProject',
      'syncExperimentalOtToggleForProject','applyPanelTheme','renderReasoningOptions','renderSpeedOptions',
      'syncCustomInstructionsEditorForProject','applyPanelWidth','renderModelConfigChoices','updateModelDisplay','syncModeControls',
      'renderRunHistory','renderContextSelection','renderContextSummary','renderComposerAttachments','applyLocaleToPanel','renderContextFiles',
      'closeDiagnosticsMenu','flushPendingStreamRenders','collapseRunProcess','renderPendingInputs'].map(name => [name, no]))
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/diagnosticsPanel.js'), 'utf8'), context);
  context.DiagnosticsPanel = context.window.CodexOverleafDiagnosticsPanel;
  const names = ['safeRunTask','runTask','startRunView','clearTaskComposer','readPanelInputs','readSelectedModelInput',
    'readSelectedSpeedInput','persistComposerAttachmentsToState','applyStateToPanel','captureCurrentExecutionSnapshot',
    'buildCodexRunParams','buildSessionHistoryResult','throwIfRunCancellationRequested','createRunCancellationError','awaitRunStep',
    'runSensitivePreflight','updateAuditSensitiveFindings','finalizeAuditDraftPartial','finalizeAuditRecord',
    'formatProjectSnapshotWarning','mergeProjectWithSyncChangeBaseFiles','syncChangeHasPreviousFile','getProjectSnapshotWarnings','isTextSnapshotFile','uniqueContentSignatures','resolveWarmMirrorReuse','getMirrorFreshness',
    'buildSnapshotFileOverlays','normalizeSnapshotPath','appendRunCancelledReport','isRunCancellationError','findRunRecord','touchSessionForTerminalRun','finishRunView','setRunning','sendTrackedCodexRun'];
  for (const name of names) vm.runInContext(extractFunction(runtime, name), context);
  const realPreflight = context.runSensitivePreflight;
  context.runSensitivePreflight = async input => {
    const outcome = await realPreflight(input);
    io.scans.push({ projectContainsMarker: JSON.stringify(input.project).includes(MARKER), useExistingMirror: input.useExistingMirror, outcome: clone(outcome) });
    return outcome;
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/otWarmMirror.js'), 'utf8'), context);
  const warmMirror = context.window.CodexOverleafOtWarmMirror.create({ ...context,
    otWarmMirrorController: OtWarmMirrorController, runController, mirrorHealth: MirrorHealth, projectFiles: ProjectFiles,
    getPanel: () => panel, getState: () => context.state, setState: value => { context.state = value; },
    getCurrentRunView: () => context.currentRunView, finishRunView: (...args) => context.finishRunView(...args) });
  context.resolveWarmRunStart = warmMirror.resolveWarmRunStart;
  context.prepareMirrorStaleRetry = async input => { const result = await warmMirror.prepareMirrorStaleRetry(input); io.retryGuards.push(clone(result)); return result; };
  vm.runInContext(sessionManagerSource, context);
  const manager = context.window.CodexOverleafSessionManager.create({ SessionState,
    SessionPanel: { update: no }, SessionMenuView: { create: () => ({ applySessionLabel: no, bindActiveSessionHeader: no, closeSessionMenu: no }) },
    tr: context.tr, showPluginConfirm: context.showPluginConfirm, showPluginToast: no,
    sendBackgroundNative: async () => { throw new Error('unexpected_session_native_IO'); },
    saveState: context.saveState, saveStateSoon: no,
    readPanelInputs: () => context.readPanelInputs(), applyStateToPanel: options => context.applyStateToPanel(options),
    syncSessionProvider: async () => {}, getPanel: () => panel, getState: () => context.state,
    setState: value => { context.state = value; }, getSessionPanelInstance: () => ({}), formatSessionTime: () => '' });
  for (const name of ['findSessionById','replaceSessionInState','updateSessionById','renderSessionList','applySessionLabel']) context[name] = manager[name];
  const realRun = context.runTask;
  context.runTask = options => { pendingRun = realRun(options); return pendingRun; };
  context.applyStateToPanel();
  return {
    io, context, manager, barrier, controls,
    start() { context.safeRunTask(); assert.ok(pendingRun, 'safe entry must dispatch the real runTask'); return pendingRun; },
    type(value) { controls.get('[data-task]').value = value; context.readPanelInputs(); },
    async switchToB(value = 'new B draft') { await manager.switchSession('B'); this.type(value); },
    changeProject() { projectId = 'project-two'; context.activeProjectId = projectId; context.window.location.pathname = '/project/project-two'; },
    changeAccount() { context.cachedAccountScopeId = 'account-two'; },
    snapshot() { return { requestCount: io.requests.length, markerInDispatchedProject: io.requests.map(p => JSON.stringify(p.project || {}).includes(MARKER)),
      useExistingMirror: io.requests.map(p => Boolean(p.useExistingMirror)), restrictToFocusFiles: io.requests.map(p => Boolean(p.restrictToFocusFiles)),
      scanCount: io.scans.length, scannedMarker: io.scans.map(s => s.projectContainsMarker),
      mirrorScans: io.mirrorScans, snapshotReads: io.snapshotReads, retryGuardOk: io.retryGuards.map(r => r.ok),
      prompts: io.prompts.map(p => p.title), completionStatuses: io.reports.map(r => r.status),
      runStatus: context.state.sessions.find(s => s.id === 'A').runs[0]?.status, errors: io.errors }; }
  };
}
module.exports = { harness, project, CLEAN, MARKER };
