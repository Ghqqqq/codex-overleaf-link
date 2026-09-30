const assert = require('node:assert/strict');
const test = require('node:test');
const Panel = require('../extension/src/content/scopedPersistencePanelState');
const Sessions = require('../extension/src/content/sessionPersistence');
const Db = require('../extension/src/shared/storageDb');
const State = require('../extension/src/shared/sessionState');
const Settlement = require('../extension/src/shared/writebackSettlement');
const { confirmReviewWriteback } = require('../extension/src/page/saveState');

function pendingRun(id = 'review-run') {
  return { id, task: 'QA', status: 'completed', mode: 'auto', runProjectId: 'project-a',
    trackedChangeStatus: 'pending', undoStatus: 'ready',
    executionSnapshot: { requireReviewing: true, mode: 'auto', source: 'submitted' },
    appliedOperations: [{ type: 'edit', path: 'notes.tex', patches: [{ search: 'before', replace: 'after' }] }],
    undoOperations: [], undoBaseFiles: [],
    undoExpectedFiles: [{ path: 'notes.tex', content: 'before' }],
    undoTrackedChanges: [{ key: 'native:doc-a:change-a', id: 'change-a', path: 'notes.tex' }] };
}
function terminal(run, status) {
  return Settlement.applySettlementTransition(run, Settlement.transitionTrackedChangeStatus(status));
}
function harness() {
  const original = { id: 'session-a', projectId: 'project-a', accountScopeId: 'account-a',
    title: 'original', updatedAt: '2026-09-22T01:00:00Z', runs: [pendingRun()] };
  let rows = [structuredClone(original)];
  const storage = { ...Db, getAllByIndex: async () => structuredClone(rows),
    putRecords: async (_store, records) => {
      for (const record of records) {
        const index = rows.findIndex(row => row.id === record.id);
        if (index < 0) rows.push(structuredClone(record)); else rows[index] = structuredClone(record);
      }
      return records.map(record => structuredClone(rows.find(saved => saved.id === record.id)));
    }, deleteRecord: async (_store, id) => { rows = rows.filter(row => row.id !== id); } };
  const migration = { loadPrefs: async () => ({}), savePrefs: async () => {},
    loadSessionTombstones: async () => ({}), getDeletedSessionIds: () => [] };
  const persist = (state, options = {}) => Panel.persistPanelState({ state, compactState: state,
    projectId: 'project-a', StorageDb: storage, SessionPersistence: Sessions, Migration: migration,
    normalizeExperimentalOtByProject: value => value || {},
    normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    persistenceContext: { scope: { accountScopeId: 'account-a', projectId: 'project-a' }, nextMeta: {} },
    ...options });
  return { original, storage, migration, persist, get rows() { return rows; },
    set rows(value) { rows = structuredClone(value); } };
}
for (const status of ['accepted', 'rejected']) {
  test(status + ' survives actual panel/session persistence with a newer stored session', async () => {
    const h = harness(), live = structuredClone(h.original);
    h.rows = [{ ...h.original, title: 'newer title', updatedAt: '2026-09-22T02:00:00Z' }];
    live.runs[0] = terminal(live.runs[0], status);
    await h.persist({ sessions: [live], activeSessionId: live.id }, { reviewRunIds: ['review-run'] });
    const saved = h.rows[0];
    assert.equal(saved.title, 'newer title', 'do not overwrite concurrent session metadata');
    assert.equal(saved.runs[0].trackedChangeStatus, status);
    const restored = State.normalizePanelState({ sessions: [saved], activeSessionId: saved.id });
    assert.equal(restored.runs[0].trackedChangeStatus, status);
    assert.deepEqual(restored.runs[0].undoTrackedChanges, []);
    const stale = { ...h.original, updatedAt: '2099-01-01T00:00:00Z', task: 'new draft' };
    await h.persist({ sessions: [stale], activeSessionId: stale.id });
    assert.equal(h.rows[0].runs[0].trackedChangeStatus, status, 'a later generic save cannot resurrect pending');
    assert.equal(h.rows[0].task, 'new draft');
  });
}
test('review transition reconciles detached active-run aliases before persistence', async () => {
  const h = harness();
  const state = { sessions: [structuredClone(h.original)], runs: [pendingRun()], activeSessionId: 'session-a' };
  assert.notEqual(state.runs[0], state.sessions[0].runs[0]);
  await Panel.applyReviewTransition({ getState: () => state, runId: 'review-run',
    transition: terminal(state.runs[0], 'accepted'), persist: options => h.persist(state, options) });
  assert.equal(state.runs[0].trackedChangeStatus, 'accepted');
  assert.equal(state.sessions[0].runs[0].trackedChangeStatus, 'accepted');
  assert.equal(h.rows[0].runs[0].trackedChangeStatus, 'accepted');
  assert.ok(Date.parse(state.sessions[0].updatedAt) > Date.parse(h.original.updatedAt));
});
test('review persistence does not silently succeed when a session was deleted', async () => {
  const h = harness(), state = { sessions: [structuredClone(h.original)], runs: [pendingRun()] };
  h.migration.getDeletedSessionIds = () => ['session-a'];
  await assert.rejects(Panel.applyReviewTransition({ getState: () => state, runId: 'review-run',
    transition: terminal(state.runs[0], 'accepted'), persist: options => h.persist(state, options) }),
  error => error.code === 'review_state_not_persisted');
  assert.equal(state.runs[0].trackedChangeStatus, 'needs_review');
  assert.equal(state.runs[0].undoTrackedChanges.length, 1);
  assert.deepEqual(h.rows, []);
});
test('a conflicting durable review decision is never overwritten', async () => {
  const h = harness(), live = structuredClone(h.original);
  h.rows = [{ ...h.original, runs: [terminal(pendingRun(), 'accepted')] }];
  live.runs = [terminal(pendingRun(), 'rejected')];
  await assert.rejects(h.persist({ sessions: [live] }, { reviewRunIds: ['review-run'] }),
    error => error.code === 'review_state_not_persisted');
  assert.equal(h.rows[0].runs[0].trackedChangeStatus, 'accepted');
});
test('concurrent review targets are all merged without overwriting newer session fields', async () => {
  const h = harness(), live = structuredClone(h.original);
  live.runs = [terminal(pendingRun('a'), 'accepted'), terminal(pendingRun('b'), 'rejected')];
  h.rows = [{ ...h.original, title: 'newer', updatedAt: '2099-01-01T00:00:00Z',
    runs: [pendingRun('a'), pendingRun('b')] }];
  await h.persist({ sessions: [live] }, { reviewRunIds: ['a', 'b'] });
  assert.deepEqual(h.rows[0].runs.map(run => run.trackedChangeStatus), ['accepted', 'rejected']);
  assert.equal(h.rows[0].title, 'newer');
});
test('review merge does not resurrect removed runs or cross account/project boundaries', () => {
  const h = harness(), accepted = { ...h.original, runs: [terminal(pendingRun(), 'accepted')] };
  const empty = { ...h.original, runs: [], updatedAt: '2099-01-01T00:00:00Z' };
  assert.deepEqual(Db.mergeSessionReviewState(empty, accepted).runs, []);
  for (const field of ['accountScopeId', 'projectId', 'id']) {
    const different = { ...accepted, [field]: 'other' };
    assert.equal(Db.mergeSessionReviewState(h.original, different, ['review-run']), h.original);
  }
});
test('review persistence propagates failed IDB transactions and retains recovery data', async () => {
  const h = harness(), state = { sessions: [structuredClone(h.original)], runs: [pendingRun()] };
  h.storage.putRecords = async () => { throw new Error('IDB transaction aborted'); };
  await assert.rejects(Panel.applyReviewTransition({ getState: () => state, runId: 'review-run',
    transition: terminal(state.runs[0], 'rejected'), persist: options => h.persist(state, options) }), /IDB transaction aborted/);
  assert.equal(state.runs[0].trackedChangeStatus, 'needs_review');
  assert.equal(h.rows[0].runs[0].trackedChangeStatus, 'pending');
  assert.deepEqual(state.runs[0].undoExpectedFiles, [{ path: 'notes.tex', content: 'before' }]);
});

function reviewResult(content = 'before') {
  return { ok: true, applied: [{ trackedChange: { path: 'notes.tex', key: 'editor-undo:notes.tex' },
    result: { ok: true, method: 'overleaf-editor-undo', verified: true, verifiedContent: content } }], skipped: [] };
}
function server(content = 'before', source = 'overleaf-zip') {
  return { ok: true, files: [{ path: 'notes.tex', content, source }] };
}
function verification(options = {}) {
  let time = 0, calls = 0;
  return confirmReviewWriteback({ params: { runProjectId: 'project-a',
    expectedFiles: [{ path: 'notes.tex', content: 'before' }] }, result: reviewResult(),
    getProjectId: () => 'project-a', now: () => time, timeoutMs: 900,
    delay: async ms => { time += ms; },
    readSnapshot: async params => {
      assert.equal(params.force, true); assert.equal(params.maxAgeMs, 0);
      assert.ok(params.zipTimeoutMs > 0 && params.zipTimeoutMs <= 8000);
      return (++calls < 2) ? server('after') : server();
    }, ...options });
}
test('Undo waits for exact fresh server content instead of the initial local editor result', async () => {
  const result = await verification();
  assert.equal(result.ok, true);
  assert.equal(result.saveVerification.state, 'verified_saved');
  assert.equal(result.saveVerification.attempts, 2);
});
test('Undo stays pending until the server read finishes', async () => {
  let resolveRead, signalRead, completed = false;
  const started = new Promise(resolve => { signalRead = resolve; });
  const pending = verification({ readSnapshot: () => {
    signalRead(); return new Promise(resolve => { resolveRead = resolve; });
  } }).then(value => { completed = true; return value; });
  await started; assert.equal(completed, false); resolveRead(server());
  assert.equal((await pending).ok, true);
});
for (const [name, snapshot] of [
  ['stale server text', server('after')],
  ['local editor overlay', server('before', 'active-editor')],
  ['quiet editor without server proof', { ok: true, state: 'verified_quiet', files: [] }]
]) {
  test('Undo refuses a false terminal from ' + name, async () => {
    const result = await verification({ readSnapshot: async () => snapshot });
    assert.equal(result.ok, false);
    assert.equal(result.skipped[0].result.code, 'undo_not_verified');
    const settled = Settlement.settleTrackedChangeLifecycle({ kind: 'reject', run: pendingRun(), result });
    assert.equal(settled.decision, 'needs_review');
    assert.equal(result.applied.length, 1, 'keep evidence of the already-applied edit');
  });
}
test('Undo confirmation cannot cross a navigation boundary', async () => {
  let project = 'project-a';
  const result = await verification({ getProjectId: () => project, readSnapshot: async () => {
    project = 'project-b'; return server();
  } });
  assert.equal(result.ok, false);
});
test('Undo confirmation verifies every file and preserves verified rebase envelopes', async () => {
  const params = { runProjectId: 'project-a', expectedFiles: [
    { path: 'notes.tex', content: 'before' }, { path: 'sub/nested.tex', content: 'nested-before' }] };
  const result = reviewResult('prefix-before-suffix');
  result.applied.push({ trackedChange: { path: 'sub/nested.tex' },
    result: { ok: true, verifiedContent: 'nested-before' } });
  const missing = await verification({ params, result, readSnapshot: async () => server('prefix-before-suffix') });
  assert.equal(missing.ok, false);
  const complete = await verification({ params, result, readSnapshot: async () => ({ ok: true, files: [
    ...server('prefix-before-suffix').files,
    { path: 'sub/nested.tex', content: 'nested-before', source: 'overleaf-zip' }] }) });
  assert.equal(complete.ok, true);
});
test('a blocked native action bypasses confirmation without another mutation or read', async () => {
  const result = { ok: false, applied: [], skipped: [{ result: { code: 'native_reject_mixed_changes' } }] };
  assert.equal(await verification({ result, readSnapshot: async () => { throw new Error('must not read'); } }), result);
});
test('server read failures are bounded and never become Undone', async () => {
  const result = await verification({ readSnapshot: async () => { throw new Error('offline'); } });
  assert.equal(result.ok, false);
  assert.equal(result.saveVerification.state, 'unknown_timeout');
});

for (const durableStatus of [null, 'rejected']) {
  test('review persistence verifies the durable response instead of the proposed accepted state: ' + durableStatus, async () => {
    const h = harness();
    const state = { sessions: [structuredClone(h.original)], runs: [pendingRun()], activeSessionId: 'session-a' };
    h.storage.putRecords = async () => durableStatus
      ? [{ ...h.original, runs: [terminal(pendingRun(), durableStatus)] }] : [];
    await assert.rejects(Panel.applyReviewTransition({ getState: () => state, runId: 'review-run',
      transition: terminal(state.runs[0], 'accepted'), persist: options => h.persist(state, options) }),
      error => error.code === 'review_state_not_persisted');
    assert.equal(state.runs[0].trackedChangeStatus, 'needs_review');
    assert.equal(state.sessions[0].runs[0].trackedChangeStatus, 'needs_review');
    assert.equal(state.runs[0].undoTrackedChanges.length, 1);
  });
}
