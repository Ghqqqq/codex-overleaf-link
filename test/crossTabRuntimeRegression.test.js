const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');
const SharedSessions = require('../extension/src/backgroundSharedSessions');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');

const runtimeSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function hydrate(input, shared) {
  const source = runtimeSource.match(/  function normalizeLoadedPanelState\(input\) \{[^]*?\n  \}/);
  assert.ok(source, 'initial and SPA hydration must share the same recovery policy');
  const context = {
    Modules: { StorageDb: { sharedSessionsEnabled: () => shared } },
    normalizePanelState: SessionState.normalizePanelState,
    getGlobalPreferences: () => ({ overlay: value => value })
  };
  vm.createContext(context);
  vm.runInContext(source[0], context);
  return context.normalizeLoadedPanelState(input);
}

function runningState() {
  return SessionState.normalizePanelState({
    activeSessionId: 'session-1',
    sessions: [{
      id: 'session-1', title: 'Cross-tab QA', titleSource: 'manual', task: '',
      createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:01.000Z',
      runs: [{ id: 'run-1', task: 'read-only QA', status: 'running', runProjectId: 'project-1',
        startedAt: '2026-09-28T00:00:01.000Z', nativeRequestId: 'request-1',
        events: [{ title: 'Reading', status: 'running', timestamp: '2026-09-28T00:00:02.000Z' }] }]
    }]
  });
}

test('a second-origin hydrate does not create a conflicting terminal write', () => {
  const initial = runningState();
  const observer = hydrate(clone(initial), true);
  const baseRun = clone(initial.sessions[0].runs[0]);
  const observedRun = clone(observer.sessions[0].runs[0]);
  assert.deepEqual(observedRun, baseRun);
  assert.equal(observedRun.status, 'running');
  const ownerCompletion = { ...baseRun, status: 'completed', statusText: 'Done',
    finishedAt: '2026-09-28T00:00:10.000Z' };
  // Exercise the actual three-way merge in both commit orders. A passive
  // reader must neither conflict with nor roll back the owner's completion.
  assert.deepEqual(SharedSessions.mergeValue(baseRun, observedRun, ownerCompletion), ownerCompletion);
  assert.deepEqual(SharedSessions.mergeValue(baseRun, ownerCompletion, observedRun), ownerCompletion);
  assert.match(runtimeSource, /state = normalizeLoadedPanelState\(await loadStoredState\(\)\)/);
  assert.match(runtimeSource, /state = normalizeLoadedPanelState\(reloaded\)/);
});

test('legacy origin-local hydration retains interrupted-run recovery', () => {
  const restored = hydrate(runningState(), false);
  assert.equal(restored.runs[0].status, 'interrupted');
  assert.ok(restored.runs[0].events.some(event => event.failure?.source === 'panel_reload'));
});

function journalHarness(journal) {
  return ActiveTurnControl.create({ chrome: { runtime: {
    async sendMessage() { return { ok: true, journals: [journal] }; }
  } } });
}

test('shared recovery leaves a terminal native journal with a live page owner untouched', async () => {
  const session = runningState().sessions[0];
  const before = clone(session);
  let paused = false;
  const control = journalHarness({ requestId: 'request-1', projectKey: 'project-1',
    sessionId: session.id, clientRunId: 'run-1', terminal: true, ownerLost: false, events: [] });
  const result = await control.recoverJournals({ projectKey: 'project-1', requireOwnerLost: true,
    findSession: () => session, pauseSessionQueue: () => { paused = true; } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.acknowledgeIds, []);
  assert.deepEqual(clone(session), before);
  assert.equal(paused, false);
  control.destroy();
});

test('an owner-lost shared journal still recovers the interrupted task and pauses its queue', async () => {
  const session = runningState().sessions[0];
  let paused = false;
  const control = journalHarness({ requestId: 'request-1', projectKey: 'project-1',
    sessionId: session.id, clientRunId: 'run-1', terminal: false, ownerLost: true,
    updatedAt: '2026-09-28T00:00:05.000Z', events: [] });
  const result = await control.recoverJournals({ projectKey: 'project-1', requireOwnerLost: true,
    findSession: () => session,
    normalizeInterruptedRun: record => Object.assign(record, SessionState.normalizeRuns([record], {
      restoreRunningRuns: true, locale: 'en'
    })[0]),
    pauseSessionQueue: () => { paused = true; } });
  assert.equal(result.changed, true);
  assert.deepEqual(result.acknowledgeIds, ['request-1']);
  assert.equal(session.runs[0].status, 'interrupted');
  assert.equal(session.runs[0].interruptedDraft.reason, 'page_owner_lost');
  assert.ok(session.runs[0].events.some(event => event.failure?.source === 'panel_reload'));
  assert.equal(paused, true);
  control.destroy();
});

test('toggling the Popup launcher preference preserves the open panel', () => {
  let handler;
  let visible = true;
  let closed = 0;
  let response;
  const source = runtimeSource.match(/  chrome\.runtime\.onMessage\.addListener\(\(message, _sender, sendResponse\) => \{[^]*?\n  \}\);/);
  assert.ok(source);
  vm.runInNewContext(source[0], {
    chrome: { runtime: { onMessage: { addListener: callback => { handler = callback; } } } },
    updateIdleClient: null, panelRendererInstance: {},
    PanelRenderer: {
      isLauncherVisible: () => visible,
      setLauncherVisible: (_instance, value, options) => {
        assert.equal(options.persist, true);
        visible = value;
      }
    },
    closePanel: () => { closed += 1; },
    getPanelStateResponse: () => ({ open: closed === 0, launcherVisible: visible })
  });
  for (const expected of [false, true]) {
    handler({ type: 'codex-overleaf/toggle-launcher' }, {}, value => { response = value; });
    assert.equal(response.open, true);
    assert.equal(response.launcherVisible, expected);
    assert.equal(closed, 0);
  }
  assert.doesNotMatch(runtimeSource, /onLauncherVisibilityChange:\s*visible\s*=>\s*\{\s*if\s*\(!visible\)\s*closePanel/);
});
