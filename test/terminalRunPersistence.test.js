const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimePath = path.join(__dirname, '..', 'extension', 'src', 'content', 'contentRuntime.js');
const runtimeSource = fs.readFileSync(runtimePath, 'utf8');

function extractFunction(source, name) {
  const startPattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = startPattern.exec(source);
  assert.ok(match, `${name} must exist`);
  const start = match.index;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

test('terminal settlement flushes after an older running snapshot instead of racing it', async () => {
  const createHarness = new Function(`
    let state = { status: 'running' };
    let saveStateTimer = null;
    let saveStateInFlight = false;
    let saveStateRunAfterFlight = false;
    let saveStateInFlightPromise = null;
    let pendingSaveStateOptions = null;
    let nextTimerId = 1;
    const timers = new Map();
    const pendingSaves = [];
    const persistedStatuses = [];
    const setTimeout = callback => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    };
    const clearTimeout = id => timers.delete(id);
    async function saveState() {
      const snapshot = state.status;
      await new Promise(resolve => pendingSaves.push({ resolve, snapshot }));
      persistedStatuses.push(snapshot);
    }
    function isStorageQuotaError() { return false; }
    function emitStorageQuotaFailure() {}
    function appendPlainLog() {}
    function tx(value) { return value; }
    function formatStateSaveError(error) { return String(error); }
    ${extractFunction(runtimeSource, 'mergeSaveStateOptions')}
    ${extractFunction(runtimeSource, 'saveStateSoon')}
    ${extractFunction(runtimeSource, 'runQueuedSaveState')}
    ${extractFunction(runtimeSource, 'flushQueuedSaveState')}
    return {
      beginSave: runQueuedSaveState,
      scheduleSave: saveStateSoon,
      flush: flushQueuedSaveState,
      setStatus(value) { state.status = value; },
      pendingSaves,
      persistedStatuses
    };
  `);
  const harness = createHarness();

  harness.beginSave();
  assert.equal(harness.pendingSaves.length, 1);
  harness.setStatus('completed');
  harness.scheduleSave();
  const flushPromise = harness.flush();

  harness.pendingSaves.shift().resolve();
  for (let index = 0; index < 10 && harness.pendingSaves.length === 0; index += 1) {
    await Promise.resolve();
  }
  assert.equal(harness.pendingSaves.length, 1, 'flush must persist one fresh terminal snapshot');
  harness.pendingSaves.shift().resolve();
  await flushPromise;

  assert.deepEqual(harness.persistedStatuses, ['running', 'completed']);
});

test('run settlement uses the serialized terminal-state flush', () => {
  assert.match(runtimeSource, /await flushQueuedSaveState\(\)\.catch\(\(\) => \{\}\)/);
  assert.match(
    runtimeSource,
    /await flushQueuedSaveState\(\)\.catch\(\(\) => \{\}\);[\s\S]{0,120}currentRunView = null;/
  );
});

test('terminal status becomes visible only after its durable save barrier', () => {
  const finishBody = extractFunction(runtimeSource, 'finishRunView');
  assert.match(finishBody, /^async function finishRunView/);

  const flushIndex = finishBody.indexOf('await flushQueuedSaveState().catch(() => {})');
  const sessionRenderIndex = finishBody.indexOf('renderSessionList()');
  const statusRenderIndex = finishBody.indexOf('visibleView.root.dataset.status = status');
  const collapseIndex = finishBody.indexOf('collapseRunProcess(visibleView, statusText)');

  assert.ok(flushIndex >= 0, 'finishRunView must await a durable terminal-state flush');
  assert.ok(sessionRenderIndex > flushIndex, 'session terminal state must render after persistence');
  assert.ok(statusRenderIndex > flushIndex, 'run terminal badge must render after persistence');
  assert.ok(collapseIndex > flushIndex, 'terminal process summary must render after persistence');
});

test('every content-runtime terminal settlement awaits the persistence barrier', () => {
  const invocationLines = runtimeSource
    .split('\n')
    .filter(line => line.includes('finishRunView(') && !line.includes('function finishRunView('));

  assert.ok(invocationLines.length > 0);
  for (const line of invocationLines) {
    assert.match(line, /await finishRunView\(/, `unawaited terminal settlement: ${line.trim()}`);
  }
});

// Review-action terminal controls must wait for the same serialized save barrier.
const { extractFunction: extractProductionFunction } = require('./_helpers/extractFunction');
const ReviewSettlement = require('../extension/src/shared/writebackSettlement');
const ReviewSessionState = require('../extension/src/shared/sessionState');
const ReviewStorageDb = require('../extension/src/shared/storageDb');
const ReviewFailureReasons = require('../extension/src/shared/failureReasons');
const reviewTimelineSource = fs.readFileSync(path.join(__dirname, '../extension/src/content/runTimelineView.js'), 'utf8');
const reviewActionSource = [
  ...['acceptRun', 'undoRunTrackedChanges', 'applyTrackedChangeSettlement', 'mergeSaveStateOptions',
    'saveStateSoon', 'runQueuedSaveState', 'flushQueuedSaveState'].map(name => extractProductionFunction(runtimeSource, name)),
  ...['configureAcceptButton', 'configureLifecycleUndoButton'].map(name => extractProductionFunction(reviewTimelineSource, name))
].join('\n');
const drainReviewMicrotasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function createReviewPersistenceHarness(options = {}) {
  const run = { id: 'review-run', task: 'QA', mode: 'auto', status: 'completed', runProjectId: 'project-a',
    trackedChangeStatus: 'pending', undoStatus: 'ready',
    executionSnapshot: { mode: 'auto', model: 'gpt-5.6-luna', reasoningEffort: 'high',
      requireReviewing: true, focusFiles: ['notes.tex'], capturedAt: '2026-09-22T00:00:00.000Z', source: 'submitted' },
    undoTrackedChanges: [{ id: 'change-a', path: 'notes.tex', type: 'insert', from: 7, to: 13 }],
    undoExpectedFiles: [{ path: 'notes.tex', content: '% base\n' }],
    undoPostFiles: [{ path: 'notes.tex', content: '% base\n% new\n' }] };
  // Start at the live post-write boundary; reload the durable result through the real codecs below.
  const session = { id: 'review-session', title: 'QA', runs: [run] };
  const state = { activeSessionId: session.id, sessions: [session], runs: session.runs };
  return new Function('state', 'WritebackSettlement', 'StorageDb', 'FailureReasons', 'options', 'PanelState', `
    const Modules = { ScopedPersistenceCoordinator: PanelState };
    const record = state.runs[0];
    const trackedChangeInFlight = new Map(), timers = new Map(), pendingSaves = [], saved = [], calls = [];
    let saveStateTimer = null, saveStateInFlight = false, saveStateRunAfterFlight = false;
    let saveStateInFlightPromise = null, pendingSaveStateOptions = null, timerId = 0;
    const setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
    const clearTimeout = id => timers.delete(id);
    async function saveState() {
      if (options.saveError) throw new Error('durable storage failed');
      const snapshot = StorageDb.buildSessionRecord(JSON.parse(JSON.stringify({
        ...state.sessions[0], projectId: 'project-a', accountScopeId: 'account-a'
      })), { preserveRunActionPayload: true });
      await new Promise(resolve => pendingSaves.push({ resolve, snapshot }));
      saved.push(snapshot);
    }
    function button() { return { hidden: false, disabled: false, textContent: '', title: '',
      cloneNode: button, replaceWith(next) { root.accept = next; }, addEventListener() {} }; }
    const root = { accept: button(), querySelectorAll: () => [], querySelector: () => root.accept };
    let rendered = {};
    function refreshRunCardControls() {
      configureAcceptButton(root, record);
      const undo = button();
      configureLifecycleUndoButton(undo, record);
      rendered = { accept: root.accept.textContent, acceptDisabled: root.accept.disabled,
        undo: undo.textContent, undoDisabled: undo.disabled };
    }
    function findRunRecord() { return record; }
    function projectRunSettlement(value) { return WritebackSettlement.projectRunSettlement(value); }
    function isTrackedChangeLifecycleRun(value) { return Boolean(value.trackedChangeStatus); }
    function wireAcceptInlineConfirm() {}
    function undoRun() {}
    const tr = key => key, tx = en => en, truncateRunTitle = value => value;
    const formatTrackedChangeFiles = () => 'notes.tex', formatTrackedUndoFiles = () => 'notes.tex';
    const getRunProjectIdForWriteback = value => value.runProjectId;
    const getPageBridgeTimeoutMs = () => 120000;
    const buildTrackedUndoPostFiles = value => value.undoPostFiles || [];
    const getTrackedChangeCaptureController = () => ({ hasLegacyUntrackedCheckpoint: () => false });
    const showPluginConfirm = async () => true;
    const writebackOrchestrator = { invalidateMirrorAfterUndo() {} };
    const setRunUndoStatus = () => {}, applyLegacyUndoSettlement = () => {};
    const formatBridgeResultReason = value => value?.code || '';
    const buildContentFailure = (code, data) => ({ code, ...data });
    function appendRunRecordEvent() { saveStateSoon(); }
    function appendAcceptDiagnosticEvents() {}
    async function callPageBridge(method, params) {
      calls.push({ method, params });
      if (options.throwNative) throw new Error('native failed');
      if (options.result) return options.result;
      // Use the page bridge's verified editor-Undo receipt without weakening its proof checks.
      if (method === 'rejectTrackedChanges') return { ok: true, skipped: [], applied: [{
        trackedChange: { ...params.trackedChanges[0], key: 'editor-undo:' + params.expectedFiles[0].path },
        result: { ok: true, method: 'overleaf-editor-undo', verified: true, verifiedContent: params.expectedFiles[0].content }
      }] };
      return { ok: true,
        applied: [{ trackedChange: params.trackedChanges[0], result: { ok: true } }], skipped: [] };
    }
    function isStorageQuotaError() { return false; }
    function emitStorageQuotaFailure() {}
    function appendPlainLog() {}
    function formatStateSaveError(error) { return String(error); }
    ${reviewActionSource}
    return { record, trackedChangeInFlight, pendingSaves, saved, calls,
      beginOlderSave: runQueuedSaveState, render() { refreshRunCardControls(); return rendered; },
      start: kind => kind === 'accept' ? acceptRun(record.id) : undoRunTrackedChanges(record.id, record) };
`)(state, ReviewSettlement, ReviewStorageDb, ReviewFailureReasons, options,
    require('../extension/src/content/scopedPersistencePanelState'));
}

for (const kind of ['accept', 'reject']) {
  for (const olderSave of [false, true]) {
    test(kind + ' keeps its UI lock until durable storage, including an immediate reload' + (olderSave ? ' behind an older save' : ''), async () => {
      const h = createReviewPersistenceHarness();
      if (olderSave) h.beginOlderSave();
      let completed = false;
      const action = h.start(kind).then(() => { completed = true; });
      await drainReviewMicrotasks();
      assert.equal(h.trackedChangeInFlight.get(h.record.id), kind, 'native completion must not release the save barrier');
      assert.equal(completed, false, 'the action promise must await terminal persistence');
      const saving = h.render();
      assert.equal(saving.acceptDisabled, true);
      assert.equal(saving.undoDisabled, true);
      assert.notEqual(saving.accept, 'runAcceptTrackedDone', 'a re-render must not expose Accepted before storage');
      assert.notEqual(saving.undo, 'undoApplied', 'a re-render must not expose Undone before storage');
      if (olderSave) {
        h.pendingSaves.shift().resolve();
        await drainReviewMicrotasks();
      }
      assert.equal(h.pendingSaves.length, 1);
      const expected = kind === 'accept' ? 'accepted' : 'rejected';
      assert.equal(h.pendingSaves[0].snapshot.runs[0].trackedChangeStatus, expected);
      h.pendingSaves.shift().resolve();
      await action;
      assert.equal(h.trackedChangeInFlight.size, 0);
      const shown = h.render();
      assert.equal(shown.acceptDisabled, true);
      assert.equal(shown.undoDisabled, true);
      assert.equal(kind === 'accept' ? shown.accept : shown.undo, kind === 'accept' ? 'runAcceptTrackedDone' : 'undoApplied');
      const stored = h.saved.at(-1);
      const restored = ReviewSessionState.normalizePanelState({
        activeSessionId: stored.id, sessions: [JSON.parse(JSON.stringify(stored))]
      }).runs[0];
      assert.equal(restored.trackedChangeStatus, expected);
      assert.deepEqual(restored.undoTrackedChanges, []);
      assert.equal(h.calls.length, 1, 'persistence must never replay the native mutation');
      assert.equal(h.calls[0].method, kind === 'accept' ? 'acceptTrackedChanges' : 'rejectTrackedChanges');
      assert.equal(h.calls[0].params.trackedChanges[0].id, 'change-a');
      assert.equal(h.calls[0].params.runProjectId, 'project-a');
    });
  }
}

test('blocked review proof remains pending and never becomes a persisted terminal', async () => {
  const h = createReviewPersistenceHarness({ result: { ok: false, applied: [], skipped: [{ result: {
    ok: false, changedDocument: false, failure: { code: 'aborted_project_changed', stage: 'navigation',
      severity: 'blocked', userMessage: 'Project changed', retryable: false }
  } }] } });
  await h.start('accept');
  assert.equal(h.record.trackedChangeStatus, 'pending');
  assert.equal(h.record.undoTrackedChanges.length, 1);
  assert.equal(h.trackedChangeInFlight.size, 0);
  assert.equal(h.pendingSaves.length, 0);
  assert.notEqual(h.render().accept, 'runAcceptTrackedDone');
});

test('native review failure releases the UI lock without persisting a false terminal', async () => {
  for (const kind of ['accept', 'reject']) {
    const h = createReviewPersistenceHarness({ throwNative: true });
    await assert.rejects(h.start(kind), /native failed/);
    assert.equal(h.trackedChangeInFlight.size, 0);
    assert.equal(h.record.trackedChangeStatus, 'pending');
    assert.equal(h.saved.length, 0);
  }
});

test('a failed review save remains uncertain and never exposes a false terminal', async () => {
  for (const kind of ['accept', 'reject']) {
    const h = createReviewPersistenceHarness({ saveError: true });
    await assert.rejects(h.start(kind), /durable storage failed/);
    assert.equal(h.record.trackedChangeStatus, 'needs_review');
    assert.equal(h.record.undoTrackedChanges.length, 1);
    assert.equal(h.trackedChangeInFlight.size, 0);
    assert.equal(h.saved.length, 0);
    assert.equal(h.calls.length, 1);
  }
});

test('terminal settlement advances the owning session activity monotonically', () => {
  const createHarness = new Function(`
    const state = {
      sessions: [{
        id: 'session-a',
        updatedAt: '2026-07-27T10:00:00.000Z',
        lastActivityAt: '2026-07-27T10:00:00.000Z'
      }]
    };
    ${extractFunction(runtimeSource, 'touchSessionForTerminalRun')}
    return {
      touch: touchSessionForTerminalRun,
      session: state.sessions[0]
    };
  `);
  const harness = createHarness();
  const updatedAt = harness.touch('session-a', '2026-07-27T10:00:00.000Z');

  assert.equal(updatedAt, '2026-07-27T10:00:00.001Z');
  assert.equal(harness.session.updatedAt, updatedAt);
  assert.equal(harness.session.lastActivityAt, updatedAt);
});
