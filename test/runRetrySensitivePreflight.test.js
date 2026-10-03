'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
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
function observe(name, h) { console.log('OBSERVATION ' + JSON.stringify({ name, ...h.snapshot() })); }
function isControlledSubmissionRefusal(value) {
  // A future scope/owner guard may reject safely. Unexpected execution errors
  // and missing fixture dependencies must never count as such a rejection.
  const message = String(value?.message || value || '');
  return /(?:active\s+)?(?:project|account|session|submission|draft|composer)\b[\s\S]{0,80}\b(?:changed|superseded|stale|cancelled|canceled|no longer)/i.test(message);
}
function fixtureHealthy(h, allowControlledRefusal = false) {
  const errors = h.io.errors;
  assert.equal(errors.some(value => /not defined|is not a function|Cannot read|fixture_network_forbidden|unexpected_session_native_IO/.test(value)), false,
    'fixture dependency failure: ' + errors.join('; '));
  if (!allowControlledRefusal) assert.deepEqual(errors, []);
  else for (const error of errors) assert.equal(h.io.requests.length === 0 && isControlledSubmissionRefusal(error), true,
    'only an explicit submission scope/owner refusal before Native dispatch is allowed: ' + error);
}
async function complete(promise, h, name, allowControlledRefusal = false) {
  const outcome = await promise.then(() => ({ ok: true }), error => ({ ok: false, message: error.message,
    controlledRefusal: allowControlledRefusal && h.io.requests.length === 0 && isControlledSubmissionRefusal(error) }));
  await Promise.resolve(); fixtureHealthy(h, allowControlledRefusal);
  if (!outcome.ok) assert.equal(outcome.controlledRefusal, true, 'unexpected submission rejection: ' + outcome.message);
  if (name) observe(name, h); return outcome;
}

// Core runtime declarations above are mechanically extracted from current source.
// Only DOM, persistence, Page snapshot and Native boundary I/O are synthetic.
// Neither scanner nor snapshot availability guards are replaced.
assert.equal(SensitiveScan.scanSensitiveInputs({ files: project(CLEAN + MARKER).files }).some(f => f.detectorId === 'private-key'), true);

async function run(name, options = {}) {
  const h = harness(options); await complete(h.start(), h, name);
  assert.equal(h.io.pageCalls.length, 1, 'real non-OT warm-start must obtain one overlay snapshot');
  assert.equal(h.io.pageCalls[0].params.allowZipFallback, false);
  return h;
}
function assertInitialScan(h, marker) {
  assert.equal(h.io.scans.length >= 1, true);
  assert.equal(h.io.scans[0].projectContainsMarker, marker);
  assert.equal(h.io.scans[0].useExistingMirror, true);
  assert.equal(h.io.mirrorScans, 1);
}

test('CONTROL clean stale retry passes real snapshot guard and dispatches refreshed project', { timeout: 3000 }, async () => {
  const h = await run('clean-stale-retry'); assertInitialScan(h, false);
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.requests[0].useExistingMirror, true);
  assert.equal(h.io.requests[0].otWarmStart, undefined); assert.equal(h.io.requests[1].useExistingMirror, undefined);
  assert.equal(h.io.requests[1].project.files[0].content, CLEAN);
  assert.equal(h.io.retryGuards[0].ok, true); assert.equal(h.snapshot().runStatus, 'completed');
});

test('CONTROL initial detected content is blocked by default before any codex.run', { timeout: 3000 }, async () => {
  const h = await run('first-detected-default-block', { initialProject: project(CLEAN + MARKER) }); assertInitialScan(h, true);
  assert.equal(h.io.requests.length, 0); assert.equal(h.io.prompts.length, 0); assert.equal(h.snapshot().runStatus, 'failed');
  assert.equal(h.io.scans[0].outcome.blocked, true);
});

for (const approve of [false, true]) test(`CONTROL initial detected content confirmation ${approve ? 'approval' : 'denial'} controls dispatch`, { timeout: 3000 }, async () => {
  const h = await run('first-detected-confirm-' + approve, { initialProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve, stale: false });
  assertInitialScan(h, true); assert.equal(h.io.prompts.length, 1); assert.equal(h.io.requests.length, approve ? 1 : 0);
  assert.equal(h.io.scans[0].outcome.blocked, !approve);
  assert.equal(h.io.prompts[0].message.includes(MARKER), false, 'confirmation uses redacted detector preview');
});

for (const retryProject of [ { id: 'project-one', files: [], capabilities: { fullProjectSnapshot: false } }, project('short unreadable sample') ]) test(`CONTROL unavailable retry snapshot (${retryProject.files.length ? 'short' : 'empty'}) is blocked before second dispatch`, { timeout: 3000 }, async () => {
  const h = await run('unavailable-retry-' + retryProject.files.length, { retryProject }); assertInitialScan(h, false);
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.retryGuards[0].ok, false); assert.equal(h.snapshot().runStatus, 'failed');
});

test('CONTROL clean focused partial retry keeps the existing scope restriction', { timeout: 3000 }, async () => {
  const h = await run('partial-focused', { retryProject: project(CLEAN, false), focusFiles: ['main.tex'] });
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.requests[1].restrictToFocusFiles, true);
  assert.equal(h.io.retryGuards[0].ok, true);
});

test('CONTROL partial retry without focus remains blocked', { timeout: 3000 }, async () => {
  const h = await run('partial-no-focus', { retryProject: project(CLEAN, false) });
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.retryGuards[0].ok, false);
});

test('CONTROL explicitly disabled sensitive checks allow the refreshed synthetic marker', { timeout: 3000 }, async () => {
  const h = await run('scan-disabled', { retryProject: project(CLEAN + MARKER), rules: { sensitiveCheckEnabled: false } });
  assert.equal(h.io.requests.length, 2); assert.equal(h.io.mirrorScans, 0); assert.equal(h.io.prompts.length, 0);
  assert.equal(h.io.requests[1].project.files[0].content.includes(MARKER), true);
});

test('CONTRACT default policy must block refreshed detected content before a second codex.run', { timeout: 3000 }, async () => {
  const h = await run('retry-new-marker-default', { retryProject: project(CLEAN + MARKER) }); assertInitialScan(h, false);
  assert.equal(h.io.retryGuards[0].ok, true, 'usable snapshot prerequisite is satisfied');
  assert.equal(h.io.requests.slice(1).every(p => p.project.files[0].content.includes(MARKER)), true);
  assert.equal(h.io.requests.length, 1, 'default sensitive policy must be reapplied to replacement snapshot before second Native dispatch');
});

for (const approve of [false, true]) test(`CONTRACT new retry detection must request confirmation; ${approve ? 'approval' : 'denial'} controls second dispatch`, { timeout: 3000 }, async () => {
  const h = await run('retry-new-marker-confirm-' + approve, { retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve });
  assertInitialScan(h, false); assert.equal(h.io.retryGuards[0].ok, true);
  assert.equal(h.io.prompts.length, 1, 'newly detected content requires a fresh explicit confirmation');
  assert.equal(h.io.requests.length, approve ? 2 : 1);
});


test('CONTRACT focused partial snapshot retry must also reapply default detection policy', { timeout: 3000 }, async () => {
  const h = await run('retry-focused-new-marker-default', { retryProject: project(CLEAN + MARKER, false), focusFiles: ['main.tex'] });
  assertInitialScan(h, false); assert.equal(h.io.retryGuards[0].ok, true);
  assert.equal(h.io.retryGuards[0].restrictToFocusFiles, true);
  assert.equal(h.io.requests.length, 1, 'focus scope restriction does not replace new-content sensitive detection');
});

for (const change of ['cancel', 'project', 'account', 'session']) test(`retry confirmation preserves ${change} boundary before Native dispatch`, async () => {
  const h = harness({ retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve: true, block: 'confirm' });
  const promise = h.start(); await h.barrier.entered;
  if (change === 'cancel') { h.context.runCancellationRequested = true; h.context.runCancellationController.abort(); }
  if (change === 'project') h.changeProject();
  if (change === 'account') h.changeAccount();
  if (change === 'session') await h.switchToB();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, change === 'session' ? 2 : 1);
  if (change === 'session') {
    assert.equal(h.io.requests[1].clientSessionId, 'A');
    assert.equal(h.io.requests[1].session.id, 'A');
    assert.equal(h.io.requests[1].threadId, 'thread-A');
    assert.equal(h.controls.get('[data-task]').value, 'new B draft');
  } else assert.equal(h.snapshot().runStatus, 'cancelled');
});

test('retry default block persists redacted findings in audit settlement', async () => {
  const h = await run('retry-audit', { retryProject: project(CLEAN + MARKER) });
  const audit = h.io.audits.find(a => a.resultStatus === 'blocked_sensitive');
  assert.ok(audit); assert.equal(audit.sensitiveFindings[0].detectorId, 'private-key');
  assert.equal(audit.blockedFiles[0].path, 'main.tex');
  assert.equal(JSON.stringify(audit).includes(MARKER), false);
});

test('approved retry findings survive the real final audit builder', async () => {
  const h = await run('retry-approved-audit', { retryProject: project(CLEAN + MARKER), rules: { sensitiveConfirmAllowed: true }, approve: true });
  const audit = h.io.audits.findLast(a => a.resultStatus === 'completed');
  assert.ok(audit); assert.equal(audit.sensitiveFindings.some(f => f.detectorId === 'private-key'), true);
  assert.equal(JSON.stringify(audit).includes(MARKER), false);
});
