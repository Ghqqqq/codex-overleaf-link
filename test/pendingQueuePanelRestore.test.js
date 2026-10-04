const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');
const SessionState = require('../extension/src/shared/sessionState');

const source = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const runtimeSource = source('extension/src/content/contentRuntime.js');

// DOM and unrelated settings/persistence I/O are adapters. Queue rendering,
// runtime wiring and session switching use their production implementations.
// The load/recovery seam supplies state; this does not simulate browser reload,
// IndexedDB hydration or journal ownership recovery.
class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.options = [];
    this.text = '';
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = String(value ?? ''); }
  append(...nodes) {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren() { this.children = []; this.text = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  focus() {}
  all(className) {
    return this.children.flatMap(child => [
      ...(child.className.split(/\s+/).includes(className) ? [child] : []),
      ...child.all(className)
    ]);
  }
}

function pausedState() {
  const pendingInputs = Queue.pauseAll(Queue.enqueue([], {
    text: 'Continue the restored task'
  }, { randomUUID: () => 'pending-restore', now: () => '2026-10-04T00:00:00.000Z' }).queue, 'interrupted');
  const session = SessionState.createSession({
    id: 'restored-session', task: 'Unsent draft stays here', pendingInputs
  });
  return SessionState.normalizePanelState({ sessions: [session], activeSessionId: session.id });
}

function harness(initialState = pausedState()) {
  const document = {
    createElement: tag => new Element(tag),
    createElementNS: (_namespace, tag) => new Element(tag)
  };
  const controls = new Map();
  for (const name of ['model', 'reasoning', 'speed', 'mode', 'task', 'require-reviewing',
    'auto-recompile', 'context-tray', 'pending-inputs']) {
    controls.set(`[data-${name}]`, new Element(name === 'task' ? 'textarea' : 'div'));
  }
  controls.get('[data-context-tray]').hidden = true;
  const container = controls.get('[data-pending-inputs]');
  container.hidden = true;
  const task = controls.get('[data-task]');
  const panel = { querySelector: selector => controls.get(selector) || null };
  const calls = { save: 0, saveSoon: 0, run: 0, resume: 0, setQueue: 0, input: 0, schedule: 0 };
  const noop = () => {};
  const context = vm.createContext({ document, window: {}, console });
  vm.runInContext(source('extension/src/content/pendingInputView.js'), context);
  vm.runInContext(source('extension/src/content/sessionManager.js'), context);
  Object.assign(context, {
    state: initialState,
    panel,
    currentRunView: null,
    runInputCoordinator: null,
    runQueueScheduler: null,
    RunQueueScheduler: Scheduler,
    PendingInputView: context.window.CodexOverleafPendingInputView,
    getActiveSession: SessionState.getActiveSession,
    selectionContextView: { render: noop },
    writingStyleSettings: { sync: noop },
    getThemePreference: () => 'dark',
    modelSelectHasOption: () => true,
    getRenderedModelEntries: () => [],
    composerAttachmentsRestoredOnce: false,
    composerAttachmentController: {},
    getTrackedChangeCaptureController: () => ({ schedule: noop }),
    PANEL_DEFAULT_WIDTH: 380,
    isProjectEditorRoute: () => true,
    providerSettingsCoordinator: {},
    runGuidanceController: { upsert: noop, remove: noop },
    crypto: { randomUUID: () => 'unexpected-new-queue-item' },
    tr: key => ({ queuedInputPaused: 'Queue paused', queuedInputResume: 'Resume' }[key] || key),
    saveState: async () => { calls.save++; },
    saveStateSoon: () => { calls.saveSoon++; },
    runTask: async () => { calls.run++; },
    readPanelInputs: () => {
      calls.input++;
      context.state = SessionState.updateActiveSession(context.state, { task: task.value });
    }
  });
  for (const name of ['applyPanelTheme', 'renderReasoningOptions', 'renderSpeedOptions',
    'autosizeTaskTextarea', 'syncComposerSendAvailability', 'syncExperimentalOtToggleForProject',
    'syncCustomInstructionsEditorForProject', 'applyPanelWidth', 'renderModelConfigChoices',
    'updateModelDisplay', 'syncModeControls', 'applySessionLabel', 'renderSessionList',
    'renderRunHistory', 'renderContextSelection', 'renderContextSummary', 'renderComposerAttachments',
    'renderComposerSkillInvocation', 'applyLocaleToPanel', 'renderContextFiles']) context[name] = noop;

  vm.runInContext(['initializeRunQueueScheduler', 'renderPendingInputs', 'applyStateToPanel']
    .map(name => extractFunction(runtimeSource, name)).join('\n'), context);
  const manager = context.window.CodexOverleafSessionManager.create({
    SessionState,
    SessionPanel: { update: noop },
    SessionMenuView: { create: () => ({
      applySessionLabel: noop, bindActiveSessionHeader: noop, closeSessionMenu: noop
    }) },
    tr: context.tr,
    showPluginConfirm: async () => true,
    showPluginToast: noop,
    saveState: context.saveState,
    saveStateSoon: context.saveStateSoon,
    readPanelInputs: context.readPanelInputs,
    applyStateToPanel: context.applyStateToPanel,
    getPanel: () => panel,
    getState: () => context.state,
    setState: value => { context.state = value; },
    getSessionPanelInstance: () => null
  });
  context.findSessionById = manager.findSessionById;
  context.updateSessionById = (sessionId, patch) => {
    if (Object.hasOwn(patch, 'pendingInputs')) calls.setQueue++;
    manager.updateSessionById(sessionId, patch);
  };
  context.initializeRunQueueScheduler();
  // Observe calls while preserving real scheduler behavior, including any
  // accidental queue resume or task start triggered by a future render change.
  for (const [method, count] of [['resume', 'resume'], ['scheduleOne', 'schedule']]) {
    const original = context.runQueueScheduler[method];
    context.runQueueScheduler[method] = (...args) => {
      calls[count]++;
      return original(...args);
    };
  }
  return { context, manager, calls, container, task,
    apply: options => context.applyStateToPanel(options),
    repaintQueue: () => context.renderPendingInputs() };
}

function assertPausedCard(h) {
  assert.equal(h.container.hidden, false, 'restored queue must be visible without a composer input event');
  assert.equal(h.container.dataset.state, 'paused');
  assert.equal(h.container.all('codex-pending-resume').length, 1);
  assert.equal(h.container.all('codex-pending-resume')[0].textContent, 'Resume');
  assert.equal(h.container.all('codex-pending-input').length, 1);
  assert.equal(h.container.all('codex-pending-input-text')[0].textContent, 'Continue the restored task');
}

function assertNoQueueEffects(h) {
  for (const key of ['saveSoon', 'run', 'resume', 'setQueue', 'schedule']) {
    assert.equal(h.calls[key], 0, `panel rendering must not ${key}`);
  }
}

test('loaded paused inputs and Resume appear on the first panel synchronization', () => {
  const h = harness();
  const before = JSON.stringify(h.context.state);
  h.apply();
  assertPausedCard(h);
  assert.equal(h.task.value, 'Unsent draft stays here');
  assert.equal(JSON.stringify(h.context.state), before);
  assert.equal(h.calls.save, 0);
  assert.equal(h.calls.input, 0, 'no input event or panel read is needed');
  assertNoQueueEffects(h);
});

test('a later recovery synchronization exposes the recovered queue from an initially empty panel', () => {
  const h = harness(SessionState.normalizePanelState({}));
  h.apply();
  assert.equal(h.container.hidden, true);
  h.context.state = pausedState();
  h.apply({ preserveScroll: true });
  assertPausedCard(h);
  assert.equal(h.calls.save, 0);
  assert.equal(h.calls.input, 0);
  assertNoQueueEffects(h);
});

test('real session switching clears the old queue in an empty session and restores the owning queue', async () => {
  const h = harness();
  h.apply();
  // Seed an already visible queue, as after an ordinary input/render event,
  // to check session isolation independently of first-paint visibility.
  h.repaintQueue();
  assertPausedCard(h);
  const sessionId = h.context.state.activeSessionId;
  const queueBefore = JSON.stringify(SessionState.getActiveSession(h.context.state).pendingInputs);
  await h.manager.startNewSession();
  assert.notEqual(h.context.state.activeSessionId, sessionId);
  assert.equal(h.container.hidden, true, 'an empty session must not display another session\'s queue');
  assert.equal(h.container.children.length, 0);
  assert.equal(h.task.value, '');
  await h.manager.switchSession(sessionId);
  assertPausedCard(h);
  assert.equal(h.task.value, 'Unsent draft stays here');
  assert.equal(JSON.stringify(SessionState.getActiveSession(h.context.state).pendingInputs), queueBefore);
  assert.equal(h.calls.save, 2, 'only the two session lifecycle changes save');
  assertNoQueueEffects(h);
});

test('repeated panel synchronization neither duplicates cards nor resumes or changes queue and draft', async () => {
  const h = harness();
  h.repaintQueue();
  const before = JSON.stringify(h.context.state);
  for (let i = 0; i < 3; i++) h.apply({ preserveScroll: true });
  await new Promise(resolve => setImmediate(resolve));
  assertPausedCard(h);
  assert.equal(h.container.all('codex-pending-head').length, 1);
  assert.equal(h.container.all('codex-pending-list').length, 1);
  assert.equal(h.task.value, 'Unsent draft stays here');
  assert.equal(JSON.stringify(h.context.state), before);
  assert.equal(h.calls.save, 0);
  assert.equal(h.calls.input, 0);
  assertNoQueueEffects(h);
});
