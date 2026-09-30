const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const sessions = require('../extension/src/shared/sessionState');
const storage = require('../extension/src/shared/storageDb');
const activity = require('../extension/src/shared/runActivityModel');

const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const cancelled = () => ({ title: 'Current Codex task was cancelled.', status: 'failed', kind: 'activity' });
const run = (status, events = []) => ({ id: 'cancelled-run', task: 'Test cancellation', status,
  finishedAt: '2026-09-28T06:00:00.000Z', events });
function roundTrip(value) {
  const stored = storage.buildSessionRecord({ id: 'cancellation-session', projectId: 'example-project', runs: [value] });
  return sessions.normalizeRuns(JSON.parse(JSON.stringify(stored.runs)), { restoreRunningRuns: true })[0];
}

test('the cancellation producer emits a lifecycle acknowledgement, not a failure', () => {
  const start = runtime.indexOf('  function appendRunCancelledReport()');
  const end = runtime.indexOf('  function autosizeTaskTextarea()', start);
  assert.ok(start >= 0 && end > start);
  const events = [], reports = [];
  vm.runInNewContext(runtime.slice(start, end) + '\nappendRunCancelledReport();', {
    state: {}, getActiveSession: () => ({ pendingInputs: [{ status: 'queued' }] }), tx: en => en,
    appendRunEvent: event => events.push(event), appendCompletionReport: report => reports.push(report)
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'info');
  assert.equal(events[0].activity.kind, 'lifecycle');
  assert.equal(events[0].activity.state, 'cancelled');
  assert.equal(reports[0].status, 'cancelled');
  assert.match(reports[0].nextStep, /queued/);
  assert.equal(activity.project({ events }).notices.length, 0);
  assert.doesNotMatch(runtime, /finishRunView\(tx\('Cancelled',[^\n]*'rejected'/);
});

test('cancelled and legacy rejected terminal states survive repeated persistence', () => {
  for (const status of ['cancelled', 'rejected']) {
    const original = run(status), snapshot = JSON.stringify(original);
    assert.equal(sessions.normalizeRuns([original])[0].status, 'cancelled');
    const restored = roundTrip(original);
    assert.equal(restored.status, 'cancelled');
    assert.equal(roundTrip(restored).status, 'cancelled');
    assert.equal(restored.finishedAt, original.finishedAt);
    assert.equal(JSON.stringify(original), snapshot);
  }
});

test('old corrupted pending/completed runs recover from explicit cancellation evidence', () => {
  for (const status of ['pending', 'completed']) {
    const original = run(status, [cancelled()]);
    assert.equal(sessions.normalizeRuns([original])[0].status, 'cancelled');
    assert.equal(roundTrip(original).status, 'cancelled');
    assert.equal(roundTrip(roundTrip(original)).status, 'cancelled');
    const projection = activity.project(roundTrip(original));
    assert.equal(projection.notices.length, 0);
    assert.equal(projection.diagnostics.length, 1);
  }
});

test('cancellation recovery never infers terminal state from assistant prose or failures', () => {
  const ignored = [
    { ...cancelled(), kind: 'stream', streamRole: 'assistant' },
    { ...cancelled(), kind: 'report' },
    { ...cancelled(), failure: { code: 'native_request_failed' } },
    { ...cancelled(), activity: { v: 1, kind: 'command', state: 'failed', id: 'tool-1' } },
    { ...cancelled(), activity: { v: 1, kind: 'notice', state: 'warning', noticeSource: 'guardianWarning' } }
  ];
  for (const event of ignored) {
    assert.equal(activity.isRoutineCancellationEvent(event), false);
    assert.equal(roundTrip(run('completed', [event])).status, 'completed');
  }
  assert.equal(sessions.normalizeRunStatus('pending', { events: [cancelled()] }), 'pending');
  for (const status of ['running', 'failed', 'interrupted'])
    assert.equal(sessions.normalizeRunStatus(status, run(status, [cancelled()])), status);
});

test('storage and session recovery share one status contract without false completion', () => {
  assert.equal(roundTrip(run('future-status')).status, 'pending');
  assert.equal(roundTrip(run(undefined)).status, 'completed');
  const original = { ...run('completed'), trackedChangeStatus: 'rejected' };
  assert.equal(roundTrip(original).status, 'completed');
});

test('routine cancellation stays in diagnostics while actionable failures stay visible', () => {
  const failures = [
    { title: 'Partial write', status: 'failed', failure: { code: 'writeback_partial' } },
    { title: 'Compilation failed', activity: { v: 1, kind: 'compile', state: 'failed' } },
    { title: 'Authentication required', status: 'failed', failure: { code: 'authentication_failed' } },
    { ...cancelled(), failure: { code: 'cancel_delivery_failed' } }
  ];
  const projected = activity.project({ events: [cancelled(), ...failures] });
  assert.equal(projected.diagnostics.length, 1);
  assert.equal(projected.notices.length, failures.length);
  const declined = { title: 'Cancelled: user chose not to create a new thread.', status: 'rejected' };
  assert.equal(activity.project({ events: [declined] }).notices.length, 0);
  assert.equal(activity.project({ events: [declined] }).diagnostics.length, 1);
});
