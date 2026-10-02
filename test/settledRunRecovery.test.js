const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const SessionState = require('../extension/src/shared/sessionState');

// Shape of the 1 Oct 13:52 run: its writeback retry finished (finishedAt and
// a completed report) but the record was persisted as running.
function stuckRun(extra = {}) {
  return {
    id: 'run-stuck', task: 'x', status: 'running', startedAt: '2026-10-01T13:52:44.000Z',
    finishedAt: '2026-10-01T13:58:30.500Z',
    events: [
      { title: 'Compile succeeded.', status: 'completed', timestamp: '2026-10-01T13:58:30.100Z' },
      { title: 'Task report', kind: 'report', status: 'completed', timestamp: '2026-10-01T13:58:30.400Z' },
      { title: 'Post-write save confirmation', kind: 'technical', status: 'info', timestamp: '2026-10-01T13:58:30.450Z' }
    ],
    ...extra
  };
}

test('a persisted running run that already reported completion loads as finished', () => {
  const state = SessionState.normalizePanelState({ sessions: [{ id: 's1', runs: [stuckRun()] }], activeSessionId: 's1' },
    { restoreRunningRuns: false, recoverSettledRuns: true });
  assert.equal(state.sessions[0].runs[0].status, 'completed');
});

test('a failed final report keeps the failed status', () => {
  const run = stuckRun();
  run.events[1].status = 'failed';
  assert.equal(SessionState.recoverSettledRunningRun(run).status, 'failed');
});

test('genuinely live runs stay running', () => {
  // A retry in progress: new events follow the old report.
  const retrying = stuckRun();
  retrying.events.push({ title: 'Syncing approved changes to Overleaf.', status: 'running', timestamp: '2026-10-01T14:00:00.000Z' });
  assert.equal(SessionState.recoverSettledRunningRun(retrying).status, 'running');
  // A first run that has not finished yet.
  assert.equal(SessionState.recoverSettledRunningRun(stuckRun({ finishedAt: '' })).status, 'running');
  // In-memory normalization never touches running runs.
  const state = SessionState.normalizePanelState({ sessions: [{ id: 's1', runs: [stuckRun()] }], activeSessionId: 's1' },
    { restoreRunningRuns: false });
  assert.equal(state.sessions[0].runs[0].status, 'running');
});

test('the writeback retry settles the live record, not a stale copy', () => {
  const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  const start = runtime.indexOf('async function retryRunWriteback(runId)');
  const body = runtime.slice(start, runtime.indexOf('\n  function appendUndoReviewingPolicyEvent', start));
  assert.match(body, /const live = \(\) => findRunRecord\(runId, session\.id\) \|\| record;/);
  assert.match(body, /for \(const copy of new Set\(\[record, live\(\)\]\)\)/);
  assert.match(body, /if \(!finished && copy\.status === 'running'\) copy\.status = originalStatus;/);
  assert.match(runtime, /recoverSettledRuns: true/);
});
