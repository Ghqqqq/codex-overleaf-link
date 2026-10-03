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
function harness(block = '') {
  const barrier = gate();
  const io = { requests: [], stages: [], errors: [], prompts: [], saved: [], cleared: [], events: [], completed: [], binds: [] };
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
    RunExecutionSnapshot, runController, WritebackSettlement, Modules: { ProjectFiles },
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
    getActiveFocusFiles: () => [], getCustomInstructionsForCurrentProject: () => '',
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
    finalizeAuditRecord: async () => {}, announceCrossTabRunStart: no,
    appendRunEvent: event => io.events.push(clone(event)), appendLog: no, appendPlainLog: value => io.errors.push(String(value)),
    appendTechnicalEvent: no, appendCompletionReport: no, formatModeLabel: value => value,
    listSeparator: () => ', ', formatContextItems: paths => paths.join(', '),
    pauseOtWarmMirror: async () => {}, preflightWriteSafety: async () => ({ ok: true }),
    resolveWarmRunStart: async () => ({ useExistingMirror: false }),
    getRunProjectSnapshot: () => stage('snapshot', { id: projectId,
      files: [{ path: 'main.tex', content: 'synthetic text' }], capabilities: { fullProjectSnapshot: true } }),
    formatProjectSnapshotUserLog: () => '', persistCurrentProjectReferenceFiles: no,
    getProjectSnapshotWarnings: () => ({ blocking: [], nonBlocking: [] }),
    resolveWarmMirrorReuse: async () => ({ useExistingMirror: false }),
    runSensitivePreflight: async () => ({ blocked: false, findings: [] }), getGovernanceRulesForCurrentProject: () => [],
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
        promise: stage('native', { ok: true, result: { assistantMessage: 'Synthetic completed response.', syncChanges: [], threadId: params.threadId } }) };
    } }, activeTurnControl: { bind: binding => io.binds.push(clone(binding)), release: no, acknowledge: async () => {} },
    runQueueScheduler: null, isExperimentalOtEnabled: () => false,
    showPluginConfirm: async prompt => { io.prompts.push(clone(prompt)); return true; }, showPluginToast: no,
    translateRawError: message => { io.errors.push('unexpected-run-error: ' + message); return { conclusion: message, nextStep: '' }; },
    ...Object.fromEntries(['resetAutoFollow','removeEmptyRunsMessage','scrollLogToBottom','startRunElapsedTick','stopRunElapsedTick',
      'autosizeTaskTextarea','syncComposerSendAvailability','renderComposerSkillInvocation','setExperimentalOtEnabledForProject',
      'syncExperimentalOtToggleForProject','applyPanelTheme','renderReasoningOptions','renderSpeedOptions',
      'syncCustomInstructionsEditorForProject','applyPanelWidth','renderModelConfigChoices','updateModelDisplay','syncModeControls',
      'renderRunHistory','renderContextSelection','renderContextSummary','renderComposerAttachments','applyLocaleToPanel','renderContextFiles',
      'closeDiagnosticsMenu','flushPendingStreamRenders','collapseRunProcess','renderPendingInputs'].map(name => [name, no]))
  };
  vm.createContext(context);
  const names = ['safeRunTask','runTask','startRunView','clearTaskComposer','readPanelInputs','readSelectedModelInput',
    'readSelectedSpeedInput','persistComposerAttachmentsToState','applyStateToPanel','captureCurrentExecutionSnapshot',
    'buildCodexRunParams','buildSessionHistoryResult','throwIfRunCancellationRequested','createRunCancellationError','awaitRunStep',
    'appendRunCancelledReport','isRunCancellationError','findRunRecord','touchSessionForTerminalRun','finishRunView','setRunning','sendTrackedCodexRun'];
  for (const name of names) vm.runInContext(extractFunction(runtime, name), context);
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
    snapshot() { return { activeSessionId: context.state.activeSessionId, composer: controls.get('[data-task]').value,
      sessions: context.state.sessions.map(s => ({ id: s.id, task: s.task, threadId: s.codexThreadId,
        runs: s.runs.map(r => ({ id: r.id, task: r.task, status: r.status, projectId: r.runProjectId })) })),
      requests: io.requests.map(p => ({ task: p.task, clientSessionId: p.clientSessionId, threadId: p.threadId,
        sessionMetadataId: p.session?.id, projectId: p.projectId, accountScopeId: p.accountScopeId })),
      ...(io.promptEvidence ? { promptEvidence: io.promptEvidence } : {}),
      prompts: io.prompts.map(p => p.title), ownerBindings: io.binds.map(b => ({ sessionId: b.sessionId, projectKey: b.projectKey, clientRunId: b.clientRunId })), errors: io.errors, currentRunView: context.currentRunView?.sessionId || null }; }
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
function correctOriginalSubmission(h) {
  return h.io.requests.length === 0 || h.io.requests.every(p => p.task === 'task from A' && p.clientSessionId === 'A' && p.threadId === 'thread-A');
}

test('CONTROL normal safeRunTask submits task A to session/thread A', { timeout: 3000 }, async () => {
  const h = harness(); const outcome = await complete(h.start(), h, 'normal'); assert.equal(outcome.ok, true);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').runs[0].status, 'completed');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'original B draft');
});
for (const kind of ['project','account']) test(`CONTROL ${kind} changes while provider prepares safely rejects submission`, { timeout: 3000 }, async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  kind === 'project' ? h.changeProject() : h.changeAccount(); h.barrier.release();
  const outcome = await complete(promise, h, `${kind}-guard`, true);
  assert.equal(outcome.ok, false); assert.match(outcome.message, /active project changed/i); assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
});
test('CONTROL after run creation and composer clear, session switch keeps explicit run/thread ownership and B draft', { timeout: 3000 }, async () => {
  const h = harness('snapshot'), promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, 'established-run-switch'); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.io.requests.length, 1); assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  assert.equal(h.controls.get('[data-task]').value, 'new B draft'); assert.equal(h.io.prompts.length, 1);
});
for (const block of ['provider','style','mirror']) test(`CONTRACT ${block} preparation cannot reassign original submission or erase later B draft`, { timeout: 3000 }, async () => {
  const h = harness(block), promise = h.start(); await h.barrier.entered; await h.switchToB(); h.barrier.release();
  await complete(promise, h, `${block}-switch`, true);
  assert.equal(correctOriginalSubmission(h) && h.context.state.sessions.find(s => s.id === 'B').task === 'new B draft'
    && h.controls.get('[data-task]').value === 'new B draft', true,
    'The click must remain bound to A or safely reject; B draft must remain untouched.');
});
test('CONTRACT pending mirror cannot replace clicked A task with a newer draft in the same session', { timeout: 3000 }, async () => {
  const h = harness('mirror'), promise = h.start(); await h.barrier.entered; h.type('new A draft'); h.barrier.release();
  await complete(promise, h, 'mirror-edit-draft', true);
  assert.equal(correctOriginalSubmission(h) && h.controls.get('[data-task]').value === 'new A draft', true,
    'The submitted task must stay fixed or be rejected, while later composer text survives.');
});
test('CONTRACT audit preparation cannot clear a later B draft after run A has been established', { timeout: 3000 }, async () => {
  const h = harness('audit'), promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, 'audit-switch', true); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.io.prompts.length, 1, 'real SessionManager requested confirmation and fixture user approved leaving the running A session');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

test('CONTRACT established A run cannot inject B session history into its real Native prompt', { timeout: 3000 }, async () => {
  const h = harness('snapshot');
  const markerA = 'SYNTHETIC_A_HISTORY_030', markerB = 'SYNTHETIC_B_HISTORY_030';
  h.manager.updateSessionById('A', { history: [{ task: markerA, result: 'A fixture response', at: '2026-10-03T00:00:00.000Z' }] });
  h.manager.updateSessionById('B', { history: [{ task: markerB, result: 'B fixture response', at: '2026-10-03T00:00:00.000Z' }] });
  const promise = h.start(); await h.barrier.entered;
  assert.equal(h.context.currentRunView.sessionId, 'A'); await h.switchToB(); h.barrier.release();
  await complete(promise, h, null, true);
  assert.equal(correctOriginalSubmission(h), true, 'existing explicit session/thread guard must still hold');
  assert.equal(h.io.prompts.length, 1, 'leaving running A was explicitly confirmed by the fixture user');
  assert.equal(h.context.state.sessions.find(s => s.id === 'B').task, 'new B draft');
  const request = h.io.requests[0];
  const { buildCodexTurnPrompt } = require(path.join(root, 'native-host/src/codexPromptAssembly'));
  const prompt = request ? buildCodexTurnPrompt({ params: request }) : null;
  h.io.promptEvidence = { safeRejected: !request,
    sessionLine: prompt?.systemPrompt.match(/^Session id: .*$/m)?.[0] || '',
    containsAHistory: Boolean(prompt?.systemPrompt.includes(markerA)),
    containsBHistory: Boolean(prompt?.systemPrompt.includes(markerB)), userPrompt: prompt?.userPrompt || '' };
  observe('established-run-prompt-context', h);
  assert.equal(!request || (h.io.promptEvidence.sessionLine === 'Session id: A'
    && h.io.promptEvidence.containsAHistory && !h.io.promptEvidence.containsBHistory), true,
    'Native prompt context must retain session A and its history, or reject safely; explicit thread A alone is insufficient.');
});

for (const block of ['provider', 'style', 'audit']) test(`later same-session draft survives ${block} preparation`, async () => {
  const h = harness(block), promise = h.start(); await h.barrier.entered;
  h.type('later draft in A'); h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.controls.get('[data-task]').value, 'later draft in A');
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').task, 'later draft in A');
});

test('later attachment, skill and selection edits are retained while the original submission is dispatched', async () => {
  const h = harness('audit');
  let attachments = [{ name: 'old.txt', contentBase64: 'b2xk', mimeType: 'text/plain', size: 3 }];
  let skill = { id: 'synthetic-skill', title: 'Original skill', scope: 'codex-overleaf' };
  let selection = null;
  h.context.getComposerAttachmentsForRun = () => clone(attachments);
  h.context.getComposerSkillInvocationForRun = () => clone(skill);
  h.context.selectionContextView.capture = () => selection;
  const promise = h.start(); await h.barrier.entered;
  attachments = [{ name: 'new.txt', contentBase64: 'bmV3', mimeType: 'text/plain', size: 3 }];
  skill = { id: 'later-skill', title: 'Later skill' };
  selection = { path: 'main.tex', text: 'later selected content' };
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests[0].attachments[0].name, 'old.txt');
  assert.equal(h.io.requests[0].skillInvocation.id, 'synthetic-skill');
  assert.equal(h.io.cleared.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
});

test('deleted submission owner is rejected without assigning the run to another session', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  await h.switchToB(); h.context.state.sessions = h.context.state.sessions.filter(s => s.id !== 'A');
  h.barrier.release(); const result = await complete(promise, h, null, true);
  assert.equal(result.ok, false); assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

test('repeated clicks during preparation create one run and leave later text available', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  h.type('later unsubmitted text'); h.context.safeRunTask();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(correctOriginalSubmission(h), true);
  assert.equal(h.context.state.sessions.find(s => s.id === 'A').runs.length, 1);
  assert.equal(h.controls.get('[data-task]').value, 'later unsubmitted text');
});

test('thread identity stays at submission while mutable session state changes during preparation', async () => {
  const h = harness('provider'), promise = h.start(); await h.barrier.entered;
  h.manager.updateSessionById('A', { codexThreadId: 'later-thread' });
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests[0].threadId, 'thread-A');
  assert.equal(h.io.requests[0].session.codexThreadId, 'thread-A');
});

test('queue promotion retains the current composer draft', async () => {
  const h = harness();
  const queuedInput = { id: 'queued-A', text: 'queued task', payload: RunExecutionSnapshot.toQueuePayload(h.context.captureCurrentExecutionSnapshot()) };
  await complete(h.context.runTask({ queuedInput }), h);
  assert.equal(h.io.requests[0].task, 'queued task');
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
  assert.equal(h.io.cleared.length, 0);
});

test('a later attachment still reading survives submitted-composer cleanup', async () => {
  const h = harness('audit'); let finishRead;
  h.context.FileReader = class {
    readAsDataURL() { finishRead = () => { this.result = 'data:text/plain;base64,bGF0ZXI='; this.onload(); }; }
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'extension/src/content/composerAttachments.js'), 'utf8'), h.context);
  const controller = h.context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({ getPanel: () => null });
  h.context.composerAttachmentController = controller;
  h.context.getComposerAttachmentsForRun = () => controller.getAttachmentsForRun();
  const promise = h.start(); await h.barrier.entered;
  const pending = controller.addFiles([{ name: 'later.txt', type: 'text/plain', size: 5 }]);
  assert.equal(controller.getAttachmentByteUsage().pending, 5);
  h.barrier.release(); await complete(promise, h); finishRead(); await pending;
  assert.equal(h.io.requests[0].attachments, undefined);
  assert.equal(controller.getAttachmentsForRun()[0]?.name, 'later.txt');
});

test('a later selection still waiting for Page survives submitted-composer cleanup', async () => {
  const h = harness('audit'); const pending = deferred();
  const selection = { projectId: 'project-one', path: 'main.tex', from: 0, to: 5, text: 'later', documentHash: 'a'.repeat(64) };
  const SelectionContextView = require(path.join(root, 'extension/src/content/selectionContextView'));
  const controller = SelectionContextView.create({ getState: () => h.context.state,
    getProjectId: () => 'project-one', getPanel: () => null,
    callPageBridge: () => pending.promise,
    setSelection: value => { h.context.state = SessionState.updateActiveSession(h.context.state, { selectionContext: value }); }
  });
  h.context.selectionContextView = controller;
  const promise = h.start(); await h.barrier.entered;
  const attachment = controller.attach();
  h.barrier.release(); await complete(promise, h);
  pending.resolve({ ok: true, selection }); await attachment;
  assert.equal(h.io.requests[0].selectionContext, null);
  assert.equal(controller.capture()?.text, 'later');
});

for (const change of ['project', 'account']) for (const draft of ['task from A', 'new scope draft']) test(`${change} changing during audit preserves ${draft} and cannot dispatch the old run`, async () => {
  const h = harness('audit'), promise = h.start(); await h.barrier.entered;
  if (change === 'project') h.changeProject(); else h.changeAccount();
  h.type(draft); h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 0); assert.equal(h.controls.get('[data-task]').value, draft);
  assert.equal(h.io.cleared.length, 0);
});

test('late compatibility result from a cancelled run cannot dispatch or bind into the next run', async () => {
  const h = harness('native'), oldGate = deferred(), gateEntered = deferred();
  let gateCalls = 0;
  h.context.nativeCompatibilityController.ensureForMethod = () => {
    if (++gateCalls === 1) { gateEntered.resolve(); return oldGate.promise; }
    return Promise.resolve({ ok: true, compatibility: {} });
  };
  const oldRun = h.start(); await gateEntered.promise;
  const oldId = h.context.currentRunView.recordId;
  h.context.runCancellationRequested = true; h.context.runCancellationController.abort();
  await complete(oldRun, h); await Promise.resolve();
  h.type('next run task'); const nextRun = h.start(); await h.barrier.entered;
  const nextId = h.context.currentRunView.recordId;
  assert.notEqual(nextId, oldId); assert.equal(h.io.requests.length, 1);
  oldGate.resolve({ ok: true, compatibility: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.io.requests.length, 1, 'cancelled request must never reach Native after a later run begins');
  assert.equal(h.io.binds.length, 1); assert.equal(h.io.binds[0].clientRunId, nextId);
  h.barrier.release(); await complete(nextRun, h);
  assert.equal(h.io.requests[0].clientRunId, nextId);
});

test('skill-installer early branch keeps submitted session context through a visible-session switch', async () => {
  const h = harness('audit');
  vm.runInContext(extractFunction(runtime, 'runSkillInstallerTask'), h.context);
  h.context.getComposerSkillInvocationForRun = () => ({ id: 'skill-installer', title: 'Synthetic installer' });
  const promise = h.start(); await h.barrier.entered; await h.switchToB();
  h.barrier.release(); await complete(promise, h);
  assert.equal(h.io.requests.length, 1); assert.equal(h.io.requests[0].session.id, 'A');
  assert.equal(h.io.requests[0].threadId, 'thread-A'); assert.equal(h.io.requests[0].skipMirrorSync, true);
  assert.equal(h.io.requests[0].clientSessionId, 'A'); assert.equal(h.io.binds[0].clientRunId, h.io.requests[0].clientRunId);
  assert.equal(h.controls.get('[data-task]').value, 'new B draft');
});

for (const gateStatus of ['ok', 'native_too_old']) test(`skill-installer late ${gateStatus} compatibility result cannot affect a later ordinary run`, async () => {
  const h = harness('native'), oldGate = deferred(), entered = deferred();
  vm.runInContext(extractFunction(runtime, 'runSkillInstallerTask'), h.context);
  vm.runInContext(extractFunction(runtime, 'sendNative'), h.context);
  let skill = { id: 'skill-installer', title: 'Synthetic installer' }, pingCount = 0;
  h.context.getComposerSkillInvocationForRun = () => skill;
  const NativeCompatibilityController = require(path.join(root, 'extension/src/content/nativeCompatibilityController'));
  h.context.nativeChannel.sendBackgroundNative = () => {
    if (++pingCount === 1) { entered.resolve(); return oldGate.promise; }
    return Promise.resolve({ ok: true });
  };
  h.context.nativeChannel.sendNative = request => h.context.nativeChannel.sendNativeTracked(request).promise;
  h.context.nativeCompatibilityController = NativeCompatibilityController.create({
    nativeChannel: h.context.nativeChannel, gatedMethods: new Set(['codex.run']),
    fallbackNativeCompatibility: response => ({ status: response.compatibilityStatus || 'ok' }),
    getNativeCompatibilityClassification: value => value.status,
    getCurrentRunView: () => h.context.currentRunView, appendRunEvent: h.context.appendRunEvent,
    throwIfCancellationRequested: () => h.context.throwIfRunCancellationRequested(),
    tx: h.context.tx, tr: h.context.tr
  });
  const oldRun = h.start(); await entered.promise;
  h.context.runCancellationRequested = true; h.context.runCancellationController.abort();
  await complete(oldRun, h); await Promise.resolve();
  skill = null; h.type('ordinary next task'); const nextRun = h.start(); await h.barrier.entered;
  const nextId = h.context.currentRunView.recordId;
  oldGate.resolve({ ok: true, compatibilityStatus: gateStatus }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.io.events.some(event => event.title === 'nativeCompatibilityBlockedNativeTooOld'), false, 'stale compatibility must not append failure to the new run');
  assert.equal(h.context.currentRunView.recordId, nextId);
  assert.equal(h.io.requests.length, 1, 'installer old gate must not create a second Native request');
  assert.equal(h.io.binds.length, 1); assert.equal(h.io.binds[0].clientRunId, nextId);
  h.barrier.release(); await complete(nextRun, h);
});
