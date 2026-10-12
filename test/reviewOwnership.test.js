'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNetwork, deferred } = require('./_helpers/sharedSessionServiceHarness');
const State = require('../extension/src/shared/sessionState');
const Db = require('../extension/src/shared/storageDb');
const Undo = require('../extension/src/shared/undoOperations');
const Settlement = require('../extension/src/shared/writebackSettlement');
const Review = require('../extension/src/content/runReviewController');
const Panel = require('../extension/src/content/scopedPersistencePanelState');
const Sessions = require('../extension/src/content/sessionPersistence');

const before = 'Original manuscript.\n', after = before + '% added\n';
function seed(network, tracked = false) {
  const appliedOperations = [{ type: 'edit', path: 'main.tex', replaceAll: after, verifiedContent: after }];
  const run = { id: 'r', task: 'Edit manuscript', mode: 'auto', status: 'completed', runProjectId: 'project-one',
    executionSnapshot: { mode: 'auto', requireReviewing: tracked, source: 'submitted' }, appliedOperations,
    ...Undo.buildUndoCheckpoint({ files: [{ path: 'main.tex', content: before }] }, appliedOperations) };
  if (tracked) Object.assign(run, { trackedChangeStatus: 'pending',
    undoTrackedChanges: [{ key: 'native:doc:change', id: 'change', path: 'main.tex' }] });
  const session = Db.buildSessionRecord({ id: 's', projectId: 'project-one', accountScopeId: 'account-one',
    focusFiles: ['main.tex'], runs: [run] }, { preserveRunActionPayload: true });
  network.db.seed('sessions', { accountScopeId: session.accountScopeId, projectId: session.projectId,
    id: session.id, record: session, revision: 1 });
  return session;
}

// Compose production state, review, persistence and background modules, with
// controlled confirmation/Page I/O and inert display callbacks. These fixtures
// use an ordinary snapshot restore; editor safety is tested in documentIntegrity.
function page(network, tabId, session, hooks = {}) {
  const client = network.client(tabId), db = client.bridge.decorate(Db);
  let state = State.normalizePanelState({ activeSessionId: session.id, sessions: [session] },
    { restoreRunningRuns: false, recoverSettledRuns: true });
  const scope = { ...client.scope, generation: 1 }, effects = [];
  let documentText = after;
  const run = () => state.sessions.find(item => item.id === 's').runs[0];
  const persist = options => Panel.persistPanelState({ state, compactState: State.prepareStateForStorage(state),
    projectId: scope.projectId, StorageDb: db, SessionPersistence: Sessions,
    persistenceContext: { scope: client.scope }, reviewRunIds: options?.reviewRunIds,
    Migration: { loadPrefs: async () => ({}), savePrefs: async () => {}, loadSessionTombstones: async () => ({}) },
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {} });
  const controller = Review.create({ Modules: { StorageDb: db, SessionState: State, UndoOperations: Undo,
    ScopedPersistenceCoordinator: Panel }, WritebackSettlement: Settlement, trackedChangeInFlight: new Map(),
    findRunRecord: run, getState: () => state, getCurrentProjectId: () => scope.projectId,
    getAccountScopeId: () => scope.accountScopeId, getRouteGeneration: () => scope.generation,
    getRunProjectIdForWriteback: value => value.runProjectId, getRunUndoCount: value => value.undoOperations.length,
    isTrackedChangeLifecycleRun: value => Boolean(value.trackedChangeStatus), hasTrackedEditorUndo: () => false,
    buildNoTraceUndoRestore: Undo.buildSnapshotRestoreUndo, findUnsafeFullFileUndoOperation: () => null,
    showPluginConfirm: hooks.confirm || (async () => true), getPageBridgeTimeoutMs: () => 120000,
    tr: key => key, tx: english => english, truncateRunTitle: value => value,
    formatOperationFiles: () => 'main.tex', formatTrackedChangeFiles: () => 'main.tex',
    formatOperationType: value => value, formatApplyResultReason: () => '', formatBridgeResultReason: () => '',
    appendRunRecordEvent() {}, refreshRunCardControls() {}, appendUndoReviewingPolicyEvent() {},
    setRunUndoStatus: (_id, status) => { run().undoStatus = status; },
    flushQueuedSaveState: persist, writebackOrchestrator: { invalidateMirrorAfterUndo() {} },
    isUndoResultEffectivelyApplied: Settlement.isUndoResultEffectivelyApplied,
    buildTrackedUndoPostFiles: value => value.appliedOperations.map(op => ({ path: op.path, content: op.verifiedContent })),
    buildContentFailure: Settlement.buildContentFailure,
    advanceRunUndoProgress: (value, result) => Undo.advanceUndoCheckpoint(value, result,
      file => Settlement.isUndoVerifiedContentMatching({ undoExpectedFiles: [file] }, result)),
    applyTrackedChangeSettlement: (runId, kind, result, options) => Panel.applyReviewTransition({
      getState: () => state, runId, SessionState: State, assertCurrent: options.assertCurrent, persist,
      transition: Settlement.applySettlementTransition(run(), Settlement.settleTrackedChangeLifecycle({ kind, run: run(), result })) }),
    async callPageBridge(method, params) {
      if (method === 'cancelActiveWrite') return { ok: true };
      hooks.entered?.resolve();
      if (hooks.gate) await hooks.gate.promise;
      effects.push(method);
      if (method === 'acceptTrackedChanges') return { ok: true, verified: true, skipped: [],
        applied: params.trackedChanges.map(trackedChange => ({ trackedChange, result: { ok: true, verified: true } })) };
      return { ok: true, skipped: [], applied: params.operations.map(operation => {
        documentText = operation.replaceAll;
        return { operation, result: { ok: true, verifiedContent: documentText, changedDocument: true } };
      }) };
    }
  });
  return { controller, db, scope, run, effects, persist, get state() { return state; }, get documentText() { return documentText; },
    draft: patch => { state = State.updateActiveSession(state, patch); } };
}
const stored = network => network.db.peek('sessions', ['account-one', 's']).record.runs[0];
const observe = promise => promise.then(() => null, error => error);

test('Undo survives draft/context updates during owner save, Page work and terminal save; reload cannot repeat it', async () => {
  const network = createNetwork(), entered = deferred(), gate = deferred();
  try {
    const original = seed(network), h = page(network, 1, original, { entered, gate });
    const marker = network.holdMessage('put', 1), outcome = observe(h.controller.undoRun('r'));
    await marker.entered.promise;
    h.draft({ focusFiles: [], task: 'Draft during owner save' });
    await network.deliver(marker.envelope);
    await entered.promise;
    h.draft({ task: 'Draft during Page work' });
    const terminal = network.holdMessage('put', 1);
    gate.resolve(); await terminal.entered.promise;
    h.draft({ task: 'Keep this later draft' });
    await network.deliver(terminal.envelope);
    assert.equal(await outcome, null);
    assert.equal(h.run().undoStatus, 'applied');
    assert.equal(stored(network).undoStatus, 'applied');
    assert.equal(h.state.task, 'Keep this later draft');
    assert.deepEqual(h.state.focusFiles, []);
    assert.equal(h.documentText, before);
    const stale = page(network, 2, original);
    await stale.controller.undoRun('r');
    assert.equal(stale.effects.length, 0);
    assert.equal(stale.run().undoStatus, 'applied');
  } finally { gate.resolve(); network.close(); }
});

test('failure to save ownership blocks Undo before any document effect', async () => {
  const network = createNetwork();
  try {
    const h = page(network, 1, seed(network)), held = network.holdMessage('put', 1);
    const pending = observe(h.controller.undoRun('r'));
    await held.entered.promise;
    held.envelope.resolve({ ok: false, error: { code: 'shared_store_unavailable', message: 'Storage unavailable' } });
    assert.equal((await pending)?.code, 'review_state_not_persisted');
    assert.equal(h.effects.length, 0);
    assert.equal(h.run().undoBaseFiles[0].content, after);
    assert.equal(h.documentText, after);
  } finally { network.close(); }
});

test('an active shared owner prevents a second page from dispatching Undo or Accept', async () => {
  const network = createNetwork(), entered = deferred(), gate = deferred();
  try {
    const session = seed(network), owner = page(network, 1, session, { entered, gate });
    const peer = page(network, 2, session), pending = observe(owner.controller.undoRun('r'));
    await entered.promise;
    await assert.rejects(peer.controller.undoRun('r'), { code: 'review_busy' });
    await assert.rejects(peer.controller.acceptRun('r'), { code: 'review_busy' });
    assert.equal(peer.effects.length, 0);
    gate.resolve(); assert.equal(await pending, null);
  } finally { gate.resolve(); network.close(); }
});

for (const [name, change] of Object.entries({
  project: h => { h.scope.projectId = 'other-project'; },
  account: h => { h.scope.accountScopeId = 'other-account'; },
  session: h => { h.state.activeSessionId = 'other-session'; },
  checkpoint: h => { h.run().undoBaseFiles[0].content = 'Different document'; }
})) test(`changed ${name} during confirmation cannot dispatch a stale Undo`, async () => {
  const network = createNetwork(), entered = deferred(), answer = deferred();
  try {
    const h = page(network, 1, seed(network), { confirm: () => { entered.resolve(); return answer.promise; } });
    const pending = observe(h.controller.undoRun('r'));
    await entered.promise; change(h); answer.resolve(true);
    assert.equal((await pending)?.code, 'review_context_changed');
    assert.equal(h.effects.length, 0);
    assert.equal(stored(network).undoOperations.length, 1);
  } finally { answer.resolve(false); network.close(); }
});

for (const action of ['undoRun', 'acceptRun']) test(`${action} retains recovery and later draft when its terminal save fails`, async () => {
  const network = createNetwork(), entered = deferred(), gate = deferred();
  try {
    const h = page(network, 1, seed(network, action === 'acceptRun'), { entered, gate });
    const pending = observe(h.controller[action]('r'));
    await entered.promise;
    const terminal = network.holdMessage('put', 1);
    gate.resolve(); await terminal.entered.promise;
    h.draft({ focusFiles: [], task: 'Keep the later draft' });
    terminal.envelope.resolve({ ok: false, error: { code: 'shared_store_unavailable', message: 'Storage unavailable' } });
    assert.equal((await pending)?.code, 'shared_store_unavailable');
    const field = action === 'acceptRun' ? 'trackedChangeStatus' : 'undoStatus';
    assert.equal(h.run()[field], action === 'acceptRun' ? 'needs_review' : 'partial');
    assert.equal(h.run().undoBaseFiles[0].content, after);
    assert.equal(h.run().undoOperations.length, 1);
    assert.equal(h.state.task, 'Keep the later draft');
    assert.notEqual(stored(network)[field], action === 'acceptRun' ? 'accepted' : 'applied');
  } finally { gate.resolve(); network.close(); }
});

test('Accept follows the same run through a draft update and preserves its decision across stale saves', async () => {
  const network = createNetwork(), entered = deferred(), gate = deferred();
  try {
    const original = seed(network, true), h = page(network, 1, original, { entered, gate });
    const stale = page(network, 2, original), pending = observe(h.controller.acceptRun('r'));
    await entered.promise;
    h.draft({ focusFiles: [], task: 'Next draft' });
    gate.resolve(); assert.equal(await pending, null);
    assert.equal(h.run().trackedChangeStatus, 'accepted');
    assert.equal(h.run().undoTrackedChanges.length, 0);
    await stale.persist();
    await stale.controller.acceptRun('r');
    assert.equal(stale.effects.length, 0);
    assert.equal(stored(network).trackedChangeStatus, 'accepted');
    assert.equal(h.state.task, 'Next draft');
  } finally { gate.resolve(); network.close(); }
});
