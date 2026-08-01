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
