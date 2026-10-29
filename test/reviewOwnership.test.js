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
function seed(network, tracked = false, sessionPatch = {}) {
  const appliedOperations = [{ type: 'edit', path: 'main.tex', replaceAll: after, verifiedContent: after }];
  const run = { id: 'r', task: 'Edit manuscript', mode: 'auto', status: 'completed', runProjectId: 'project-one',
    executionSnapshot: { mode: 'auto', requireReviewing: tracked, source: 'submitted' }, appliedOperations,
    ...Undo.buildUndoCheckpoint({ files: [{ path: 'main.tex', content: before }] }, appliedOperations) };
  if (tracked) Object.assign(run, { trackedChangeStatus: 'pending',
    undoTrackedChanges: [{ key: 'native:doc:change', id: 'change', path: 'main.tex' }] });
  const session = Db.buildSessionRecord({ id: 's', projectId: 'project-one', accountScopeId: 'account-one',
    focusFiles: ['main.tex'], runs: [run], ...sessionPatch }, { preserveRunActionPayload: true });
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
  // The supplied session represents the page's already hydrated visible view.
  db.adoptSharedSessionBaseline([session]);
  const scope = { ...client.scope, generation: 1 }, effects = [], events = [];
  let documentText = after;
  const run = () => state.sessions.find(item => item.id === 's').runs[0];
  const persist = async options => {
    await hooks.beforePersist?.(options);
    return Panel.persistPanelState({ state, compactState: State.prepareStateForStorage(state),
    projectId: scope.projectId, StorageDb: db, SessionPersistence: Sessions,
    persistenceContext: { scope: client.scope }, reviewRunIds: options?.reviewRunIds,
    Migration: { loadPrefs: async () => ({}), savePrefs: async () => {}, loadSessionTombstones: async () => ({}) },
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {} });
  };
  const controller = Review.create({ Modules: { StorageDb: db, SessionState: State, UndoOperations: Undo,
    ScopedPersistenceCoordinator: Panel }, WritebackSettlement: Settlement, trackedChangeInFlight: new Map(),
    findRunRecord: run, getState: () => state, getCurrentProjectId: () => scope.projectId,
    getAccountScopeId: () => scope.accountScopeId, getRouteGeneration: () => scope.generation,
    getRunProjectIdForWriteback: value => value.runProjectId, getRunUndoCount: value => value.undoOperations.length,
    isTrackedChangeLifecycleRun: value => Boolean(value.trackedChangeStatus), hasTrackedEditorUndo: () => false,
    buildNoTraceUndoRestore: Undo.buildSnapshotRestoreUndo, findUnsafeFullFileUndoOperation: () => null,
    showPluginConfirm: hooks.confirm || (async () => true), getPageBridgeTimeoutMs: () => 120000,
    tr: key => key, tx: english => english, notify: hooks.notify, truncateRunTitle: value => value,
    formatOperationFiles: () => 'main.tex', formatTrackedChangeFiles: () => 'main.tex',
    formatOperationType: value => value, formatApplyResultReason: () => '', formatBridgeResultReason: () => '',
    appendRunRecordEvent: (_id, event) => events.push(event), refreshRunCardControls() {}, appendUndoReviewingPolicyEvent() {},
    setRunUndoStatus: (_id, status) => { run().undoStatus = status; },
    flushQueuedSaveState: persist, writebackOrchestrator: { invalidateMirrorAfterUndo: (...args) => hooks.invalidateMirrorAfterUndo?.(...args) },
    isUndoResultEffectivelyApplied: Settlement.isUndoResultEffectivelyApplied,
    buildTrackedUndoPostFiles: hooks.buildTrackedUndoPostFiles
      || (value => value.appliedOperations.map(op => ({ path: op.path, content: op.verifiedContent }))),
    buildContentFailure: Settlement.buildContentFailure,
    advanceRunUndoProgress: (value, result) => Undo.advanceUndoCheckpoint(value, result,
      file => Settlement.isUndoVerifiedContentMatching({ undoExpectedFiles: [file] }, result)),
    applyTrackedChangeSettlement: (runId, kind, result, options) => Panel.applyReviewTransition({
      getState: () => state, runId, SessionState: State, assertCurrent: options.assertCurrent, persist,
      transition: Settlement.applySettlementTransition(run(), Settlement.settleTrackedChangeLifecycle({ kind, run: run(), result })) }),
    async callPageBridge(method, params) {
      if (method === 'cancelActiveWrite') return { ok: true };
      hooks.beforePageEffect?.(method);
      hooks.entered?.resolve();
      if (hooks.gate) await hooks.gate.promise;
      effects.push(method);
      if (method === 'acceptTrackedChanges') return { ok: true, verified: true, skipped: [],
        applied: params.trackedChanges.map(trackedChange => ({ trackedChange, result: { ok: true, verified: true } })) };
      const result = { ok: true, skipped: [], applied: params.operations.map(operation => {
        documentText = operation.replaceAll ?? operation.content;
        return { operation, result: { ok: true, verifiedContent: documentText, changedDocument: true } };
      }) };
      hooks.afterPageEffect?.(result);
      return result;
    }
  });
  return { controller, db, scope, run, effects, events, persist, get state() { return state; }, get documentText() { return documentText; },
    draft: patch => { state = State.updateActiveSession(state, patch); } };
}
const stored = network => network.db.peek('sessions', ['account-one', 's']).record.runs[0];
const observe = promise => promise.then(() => null, error => error);

test('file-only Undo retains its Page mutation for original-scope mirror invalidation after navigation', async () => {
  const network = createNetwork(), invalidations = [];
  try {
    const original = seed(network, false, { autoRecompile: false, runs: [{
      id: 'r', task: 'Undo a deleted file', mode: 'auto', status: 'completed',
      runProjectId: 'project-one', runAccountScopeId: 'account-one',
      undoOperations: [{ type: 'create', path: 'restored.tex', content: before }],
      undoExpectedFiles: [{ path: 'restored.tex', content: before }],
      appliedOperations: [{ type: 'delete', path: 'restored.tex' }]
    }] });
    const h = page(network, 1, original, {
      buildTrackedUndoPostFiles: () => [],
      afterPageEffect() {
        h.scope.projectId = 'project-two'; h.scope.accountScopeId = 'account-two'; h.scope.generation++;
      },
      invalidateMirrorAfterUndo: (runId, projectId, result, owner) => invalidations.push({ runId, projectId, result, owner })
    });
    const error = await observe(h.controller.undoRunTrackedChanges('r', h.run()));
    assert.equal(error?.code, 'review_context_changed');
    assert.deepEqual(h.effects, ['applyOperations']);
    assert.equal(h.documentText, before);
    assert.equal(invalidations.length, 1);
    const invalidation = invalidations[0];
    assert.equal(invalidation.runId, 'r');
    assert.equal(invalidation.projectId, 'project-one');
    assert.equal(invalidation.owner.runAccountScopeId, 'account-one');
    assert.equal(invalidation.owner.sessionId, 's');
    assert.equal(invalidation.result.applied.length, 1);
    assert.equal(invalidation.result.applied[0].operation.path, 'restored.tex');
    assert.equal(invalidation.result.applied[0].result.changedDocument, true);
  } finally { network.close(); }
});

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

test('a peer draft and manual title saved after terminal staging survive the next ordinary save', async () => {
  const network = createNetwork();
  try {
    const original = seed(network, false, { title: 'Edit manuscript', task: 'Original draft', autoRecompile: false });
    const peer = network.client(2).bridge.decorate(Db);
    let peerSaved = false;
    const h = page(network, 1, original, { beforePersist: async options => {
      if (!options?.preserveRunActionPayload || peerSaved) return;
      peerSaved = true;
      const latest = await peer.getRecord('sessions', 's');
      await peer.putRecord('sessions', { ...latest, task: 'Peer later draft', title: 'Peer later title',
        titleSource: 'manual', updatedAt: new Date(Date.parse(h.state.sessions[0].updatedAt) + 1).toISOString() });
    } });
    assert.equal(await observe(h.controller.undoRun('r')), null);
    assert.equal(stored(network).undoStatus, 'applied');
    await h.persist();
    const saved = await peer.getRecord('sessions', 's');
    assert.equal(saved.task, 'Peer later draft');
    assert.equal(saved.title, 'Peer later title');
    assert.equal(saved.titleSource, 'manual');
    assert.equal(h.state.task, 'Original draft');
    assert.equal(h.effects.filter(method => method === 'applyOperations').length, 1);
  } finally { network.close(); }
});

for (const action of ['undoRun', 'acceptRun']) {
  test(`${action} durably records its verified outcome despite a genuine envelope conflict at terminal`, async () => {
    const network = createNetwork(), notices = [];
    try {
      const original = seed(network, action === 'acceptRun', {
        title: 'Edit manuscript', task: 'Original draft', autoRecompile: false,
        updatedAt: '2026-10-01T00:00:00.000Z' });
      const peer = network.client(2).bridge.decorate(Db);
      const peerWrite = async () => {
        const latest = await peer.getRecord('sessions', 's');
        await peer.putRecord('sessions', { ...latest, task: 'Peer draft', title: 'Peer title', titleSource: 'manual',
          updatedAt: '2026-10-02T00:00:00.000Z' });
      };
      const h = page(network, 1, original, {
        notify: message => notices.push(message),
        confirm: async () => {
          // The same Undo also crosses a conflict while saving its owner marker.
          if (action === 'undoRun') {
            await peerWrite();
            h.draft({ task: 'Local conflicting draft', title: 'Local conflicting title', titleSource: 'manual' });
          }
          return true;
        },
        beforePageEffect: () => {
          if (action === 'undoRun') assert.equal(stored(network).undoOwnerProtocol, 1);
          h.draft({ task: 'Local conflicting draft', title: 'Local conflicting title', titleSource: 'manual' });
        },
        beforePersist: async options => {
          if (options?.preserveRunActionPayload) await peerWrite();
        }
      });
      const error = await observe(h.controller[action]('r'));
      const field = action === 'undoRun' ? 'undoStatus' : 'trackedChangeStatus';
      const outcome = action === 'undoRun' ? 'applied' : 'accepted';
      assert.equal(stored(network)[field], outcome);
      assert.equal(h.run()[field], outcome);
      assert.equal(Settlement.projectRunSettlement(h.run()).canUndo, false);
      assert.equal(error?.code, 'shared_session_conflict');
      assert.ok(notices.includes(error.message), 'the existing conflict notice is still reported');
      assert.equal(h.events.some(event => event.status === 'failed'), false,
        'a durable review outcome must not append a failed review event for the envelope conflict');
      assert.equal(h.state.task, 'Local conflicting draft');
      assert.equal(h.state.sessions[0].title, 'Local conflicting title');
      await assert.rejects(h.persist(), { code: 'shared_session_conflict' });
      const saved = await peer.getRecord('sessions', 's');
      assert.equal(saved.task, 'Peer draft');
      assert.equal(saved.title, 'Peer title');
      await h.controller[action]('r');
      assert.equal(h.effects.length, 1, 'the completed review cannot dispatch twice');
      if (action === 'undoRun') assert.equal(h.documentText, before);
      h.draft({ task: saved.task, title: saved.title, titleSource: saved.titleSource });
      await h.persist();
      assert.equal(stored(network)[field], outcome, 'resolving the envelope does not conflict on acknowledged review fields');
    } finally { network.close(); }
  });
}

test('run-scoped review preserves other writers and cannot replace a terminal decision or revive a removed run/session', async () => {
  const network = createNetwork();
  try {
    const original = seed(network, false, { title: 'Edit manuscript', task: 'Original draft' });
    const db = network.client(1).bridge.decorate(Db), peer = network.client(2).bridge.decorate(Db);
    const stale = page(network, 3, original);
    const scope = { projectId: original.projectId, accountScopeId: original.accountScopeId, runId: 'r' };
    const proposed = { ...original, task: 'Must not be saved', runs: [{ ...original.runs[0], undoStatus: 'applied',
      undoOperations: [], undoBaseFiles: [], appliedOperations: [], events: [{ title: 'Not review-owned' }],
      settlement: { documentEffect: 'changed', evidence: { settled: 'complete', mirrored: 'failed' } } }] };
    await assert.rejects(db.putSessionReviewState(proposed, ['r']), { code: 'storage_lock_lost' });
    await db.withSharedReviewLock(scope, async () => {
      const latest = await peer.getRecord('sessions', 's');
      await peer.putRecord('sessions', { ...latest, task: 'Peer draft', runs: [{ ...latest.runs[0],
        events: [{ title: 'Peer event' }], settlement: { evidence: { mirrored: 'confirmed' } } }] });
      const saved = await db.putSessionReviewState(proposed, ['r']);
      assert.equal(saved.task, 'Peer draft');
      assert.deepEqual(saved.runs[0].events, [{ title: 'Peer event' }]);
      assert.equal(saved.runs[0].settlement.evidence.mirrored, 'confirmed');
      assert.equal(saved.runs[0].undoStatus, 'applied');
      await assert.rejects(db.putSessionReviewState(original, ['r']), { code: 'review_state_not_persisted' });
      assert.equal(stored(network).undoStatus, 'applied');
      stale.draft({ title: 'Independent stale-page title', titleSource: 'manual' });
      await stale.persist();
      assert.equal(stored(network).undoStatus, 'applied');
      assert.equal((await peer.getRecord('sessions', 's')).title, 'Independent stale-page title');
      await peer.putRecord('sessions', { ...await peer.getRecord('sessions', 's'), runs: [] });
      await assert.rejects(db.putSessionReviewState(proposed, ['r']), { code: 'review_context_changed' });
      await peer.deleteRecord('sessions', 's', scope);
      await assert.rejects(db.putSessionReviewState(proposed, ['r']), { code: 'shared_session_deleted' });
      assert.equal(await peer.getRecord('sessions', 's'), null);
    });
  } finally { network.close(); }
});

test('first Undo persists ownership despite overlapping same-page save lock, retaining the peer title and local draft', { timeout: 5000 }, async () => {
  const network = createNetwork(), saveEntered = deferred(), releaseSave = deferred();
  try {
    const original = seed(network, false, { updatedAt: '2026-10-01T01:00:00.000Z',
      title: 'Edit manuscript', task: 'Keep this page draft', autoRecompile: false });
    const peerDb = network.client(2).bridge.decorate(Db);
    const remoteWrite = async () => {
      const latest = await peerDb.getRecord('sessions', 's');
      await peerDb.putRecord('sessions', { ...latest, title: 'Peer title retained',
        updatedAt: '2026-10-01T01:00:01.000Z' });
    };
    let priorSave;
    const h = page(network, 1, original, {
      confirm: async () => {
        releaseSave.resolve();
        assert.deepEqual(await priorSave, []);
        assert.equal(h.db.hasUnpersistedSharedSession(h.state.sessions[0]), false,
          'the old envelope still matches the page baseline before the marker save');
        return true;
      },
      beforePageEffect: method => {
        assert.equal(method, 'applyOperations');
        assert.equal(stored(network).undoOwnerProtocol, 1, 'ownership is durable before the first Page effect');
        assert.equal(stored(network).undoStatus, 'running');
        assert.equal(h.state.task, original.task);
        h.draft({ task: 'Later draft during Undo', focusFiles: [] });
      }
    });
    await h.db.claimSessionsForAccount(h.scope.projectId, h.scope.accountScopeId);
    await remoteWrite();
    priorSave = h.db.withSharedLock('state', h.scope, async () => {
      saveEntered.resolve();
      await releaseSave.promise;
      return h.persist();
    });
    await saveEntered.promise;
    assert.equal(await observe(h.controller.undoRun('r')), null, 'the first Undo succeeds');
    assert.deepEqual(h.effects, ['applyOperations'], 'exactly one Undo effect');
    assert.equal(h.documentText, before);
    assert.equal(h.run().undoStatus, 'applied');
    assert.equal(stored(network).undoStatus, 'applied');
    assert.equal(h.state.task, 'Later draft during Undo');
    assert.deepEqual(h.state.focusFiles, []);
    await h.persist();
    const saved = await peerDb.getRecord('sessions', 's');
    assert.equal(saved.title, 'Peer title retained', 'later full-session saves cannot overwrite the peer title');
    assert.equal(saved.task, h.state.task);
    assert.deepEqual(saved.focusFiles, []);
  } finally { releaseSave.resolve(); network.close(); }
});

test('older saves still skip unless shared review explicitly requests the marked run', async () => {
  const network = createNetwork();
  try {
    const original = seed(network, false, { updatedAt: '2026-10-01T01:00:00.000Z' });
    const h = page(network, 1, original), peerDb = network.client(2).bridge.decorate(Db);
    await h.db.claimSessionsForAccount(h.scope.projectId, h.scope.accountScopeId);
    const latest = await peerDb.getRecord('sessions', 's');
    await peerDb.putRecord('sessions', { ...latest, title: 'Newer peer title',
      updatedAt: '2026-10-01T01:00:01.000Z' });
    const marked = { ...original, runs: [{ ...original.runs[0], undoOwnerProtocol: 1, undoStatus: 'running' }] };
    const legacyDb = { ...h.db, sharedSessionsEnabled: () => false,
      putRecords: async () => assert.fail('legacy storage must not admit an older marker save') };
    for (const [db, record, reviewRunIds] of [
      [h.db, marked, undefined], [h.db, marked, ['other-run']], [h.db, original, ['r']],
      [legacyDb, marked, ['r']]
    ]) {
      const written = await Sessions.writeSessions({ StorageDb: db, ...h.scope,
        Migration: { loadSessionTombstones: async () => ({}) },
        sessionRecords: [db.buildSessionRecord(record, { preserveRunActionPayload: true })], reviewRunIds });
      assert.deepEqual(written, []);
    }
    const saved = await peerDb.getRecord('sessions', 's');
    assert.equal(saved.title, 'Newer peer title');
    assert.equal(saved.runs[0].undoOwnerProtocol, undefined);
  } finally { network.close(); }
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
    if (action === 'undoRun') assert.ok(h.events.some(event => event.status === 'failed'),
      'a failed review write without a durable receipt still records the Undo failure');
  } finally { gate.resolve(); network.close(); }
});

test('Accept follows the same run through a draft update and preserves its decision across stale saves', async () => {
  const network = createNetwork(), entered = deferred(), gate = deferred();
  try {
    const original = seed(network, true, { title: 'Edit manuscript' });
    original.runs[0].saveCheck = { v: 1, projectId: original.projectId, accountScopeId: original.accountScopeId,
      sessionId: original.id, runId: 'r', createdAt: '2026-10-19T00:00:00.000Z',
      files: [{ path: 'main.tex', kind: 'text', sha256: require('node:crypto').createHash('sha256').update(after).digest('hex') }] };
    network.db.seed('sessions', { accountScopeId: original.accountScopeId, projectId: original.projectId,
      id: original.id, record: original, revision: 1 });
    const h = page(network, 1, original, { entered, gate });
    const stale = page(network, 2, original), pending = observe(h.controller.acceptRun('r'));
    await entered.promise;
    h.draft({ focusFiles: [], task: 'Next draft' });
    gate.resolve(); assert.equal(await pending, null);
    assert.equal(h.run().trackedChangeStatus, 'accepted');
    assert.equal(h.run().undoTrackedChanges.length, 0);
    assert.deepEqual(stored(network).saveCheck, original.runs[0].saveCheck);
    assert.notEqual(stored(network).settlement.evidence.saved, 'verified');
    await stale.persist();
    await stale.controller.acceptRun('r');
    assert.equal(stale.effects.length, 0);
    assert.equal(stored(network).trackedChangeStatus, 'accepted');
    assert.equal(h.state.task, 'Next draft');

    // The verified save-check branch in retryRunWriteback owns these updates.
    delete h.run().saveCheck;
    h.run().saveConfirmedAt = '2026-10-19T00:01:00.000Z';
    h.run().settlement.evidence.saved = 'verified';
    await h.persist();
    const saved = await network.client(2).bridge.decorate(Db).getRecord('sessions', original.id);
    const reloaded = page(network, 3, saved);
    for (const run of [saved.runs[0], reloaded.run()]) {
      assert.equal(run.trackedChangeStatus, 'accepted');
      assert.equal(Object.hasOwn(run, 'saveCheck'), false);
      assert.equal(run.saveConfirmedAt, h.run().saveConfirmedAt);
      assert.equal(run.settlement.evidence.saved, 'verified');
    }
  } finally { gate.resolve(); network.close(); }
});

// Drive the actual Retry callback registered with the timeline. Only external
// I/O and unrelated UI controllers are substituted; no runtime source is extracted.
async function retryRuntime(write) {
  let inert;
  inert = new Proxy(function () { return inert; }, { get(_target, key) {
    if (key === 'then') return undefined;
    if (key === Symbol.toPrimitive) return () => '';
    if (key === Symbol.iterator) return function* () {};
    return inert;
  } });
  const withInert = value => new Proxy(value, { get: (target, key) => target[key] || inert });
  const callbacks = {}, snapshots = [], mounted = new Error('composer callbacks captured');
  const projectId = '0123456789abcdef01234567';
  let email = 'qa@example.org';
  const button = { disabled: false, setAttribute() {} };
  const panel = { dataset: {}, querySelector: selector =>
    ['[data-new-session]', '[data-diagnostics-snapshot]'].includes(selector) ? button : null, querySelectorAll: () => [] };
  const document = { addEventListener() {}, querySelector: selector => selector.includes('meta[name="ol-user-email"]')
    ? { getAttribute: () => email } : null };
  const window = { location: { pathname: '/project/' + projectId, href: 'https://www.overleaf.com/project/' + projectId },
    document, CodexOverleafModuleRegistry: { resolve: () => inert }, addEventListener() {}, setTimeout: () => 1 };
  const Transcript = require('../extension/src/shared/agentTranscript');
  const modules = withInert({
    SessionState: State, WritebackIntent: require('../extension/src/shared/writebackIntent'), WritebackSettlement: Settlement,
    WritebackController: require('../extension/src/content/writebackController'), AgentTranscript: Transcript, UndoOperations: Undo,
    I18n: require('../extension/src/shared/i18n'), RunActivityModel: require('../extension/src/shared/runActivityModel'), StorageDb: Db,
    PageBridgeClient: { create: () => ({ start() {}, call: async () => ({ ok: true }) }) },
    SessionManager: { create(options) { callbacks.sessions = options; return withInert({
      findSessionById: id => options.getState()?.sessions.find(session => session.id === id), isTransitioning: () => false }); } },
    RunTimelineView: { create(options) { callbacks.timeline = options; return inert; } },
    NativeCompatibilityController: { create(options) { callbacks.native = options; return inert; } },
    // Keep unrelated asynchronous startup parked while the registered UI entry is exercised.
    GlobalPreferencesController: { create: () => ({ initialize: () => new Promise(() => {}) }) },
    PanelRenderer: withInert({ create: () => ({ panelEl: panel }) }),
    ComposerPanel: { create(options) { callbacks.composer = options; throw mounted; } },
    MarkdownText: { create: () => withInert({ sanitizeAssistantVisibleText: value => value, sanitizeAssistantVisibleValue: value => value }) },
    WritebackOrchestrator: { create(options) { callbacks.writeback = options; return {
      getPendingMirrorRefresh: () => null, applySyncChangesToOverleaf: (...args) => write(harness, ...args) }; } },
    ActiveTurnControl: { create: () => ({ bindBrowserRun: async () => true, release() {} }) },
    ScopedPersistenceCoordinator: {
      createController: () => ({ async commit(id, _options, persist) {
        await persist({ scope: { projectId: id, accountScopeId: window.codexOverleafDeriveAccountScopeId() } }); return { ok: true };
      } }),
      async persistPanelState(options) { snapshots.push(JSON.parse(JSON.stringify(options.state))); return options.state.sessions; }
    },
    RunSettlementPersistence: require('../extension/src/content/runSettlementPersistence')
  });
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../extension/src/content/contentRuntime'), 'utf8'), {
    window, document, chrome: { runtime: { id: 'fixture', getManifest: () => ({}), onMessage: { addListener() {} } } },
    crypto: require('node:crypto').webcrypto, navigator: {}, Blob, URL, TextEncoder, AbortController,
    setTimeout: () => 1, clearTimeout() {}
  });
  window.CodexOverleafContentRuntime.init({ modules });
  const accountScopeId = await window.__codexOverleafLifecycle.refreshAccountScopeId();
  const project = { id: projectId, files: ['first.tex', 'main.tex'].map(path => ({ path, content: before })) };
  const operations = project.files.map(file => ({ type: 'edit', path: file.path, replaceAll: after, verifiedContent: after }));
  const applied = { ok: false, applied: [{ operation: operations[0], result: { ok: true, verified: true, verifiedContent: after } }],
    skipped: [{ operation: operations[1], result: { ok: false, code: 'write_operation_failed', changedDocument: false,
      failure: { code: 'write_operation_failed', stage: 'navigation', changedDocument: false, file: 'main.tex' } } }] };
  const report = Transcript.buildHumanCompletionReport({ mode: 'auto', status: 'failed', includeWriteResult: true,
    operations, applyResults: [applied], conclusionSource: { origin: 'product', key: 'writeback', outcome: 'partial_sync', prefixLength: 0 },
    conclusion: Transcript.projectProductConclusion({ origin: 'product', key: 'partial_sync' }, 'en') });
  const run = { id: 'r', runProjectId: projectId, mode: 'auto', status: 'failed',
    executionSnapshot: { requireReviewing: false }, ...Undo.buildUndoCheckpoint(project, [operations[0]]),
    settlement: Settlement.settle({ operations, applyResult: applied }).facts,
    events: [{ kind: 'report', title: report.title, status: report.status, timestamp: new Date().toISOString(),
      detail: report.text, detailStructured: report.structured }],
    retryWriteback: { v: 1, id: 'retry', projectId, accountScopeId, sessionId: 's', runId: 'r', createdAt: new Date().toISOString(),
      operations: [operations[1]], baseFiles: project.files } };
  callbacks.sessions.setState(State.normalizePanelState({ activeSessionId: 's', sessions: [{ id: 's', projectId, accountScopeId, runs: [run] }] }));
  assert.throws(() => callbacks.native.ensurePanelOpen(), error => error === mounted);
  const harness = { project, operation: operations[1], callbacks, snapshots,
    run: () => callbacks.timeline.findRunRecord('r', 's'), retry: () => callbacks.timeline.retryWriteback('r'),
    stop: () => callbacks.composer.callbacks.onCancel(),
    async changeScope(kind) {
      if (kind === 'project') window.location.pathname = '/project/fedcba987654321001234567';
      else { email = 'another@example.org'; await window.__codexOverleafLifecycle.refreshAccountScopeId(); }
      const state = JSON.parse(JSON.stringify(callbacks.sessions.getState()));
      state.sessions[0].projectId = callbacks.timeline.getCurrentProjectId();
      state.sessions[0].accountScopeId = window.codexOverleafDeriveAccountScopeId();
      const next = state.sessions[0].runs[0];
      next.runProjectId = state.sessions[0].projectId;
      next.status = 'running'; next.events = []; delete next.retryingWriteback;
      callbacks.sessions.setState(state);
      return next;
    }
  };
  return harness;
}

test('Retry sync Stop preserves returned writes and save evidence on its owning run', async t => {
  for (const saved of [false, true]) await t.test(saved ? 'late saved reply' : 'cancelled save confirmation', async () => {
    const h = await retryRuntime(async runtime => {
      const applied = { ok: true, applied: [{ operation: runtime.operation,
        result: { ok: true, verified: true, verifiedContent: after } }], skipped: [] };
      const saveVerification = { ok: saved, state: saved ? 'verified_saved' : 'unknown_timeout', recoveryReason: saved ? '' : 'codex_cancelled' };
      const view = runtime.callbacks.writeback.getCurrentRunView();
      await runtime.callbacks.writeback.recordUndoFromApply(runtime.project, applied);
      await runtime.callbacks.writeback.settleWritebackRecovery(applied, runtime.project, saveVerification, view, false);
      const outcome = { operations: [runtime.operation], applied, saveVerification,
        settlement: Settlement.settle({ operations: [runtime.operation], applyResult: applied, saveVerification }) };
      await runtime.stop();
      if (saved) return outcome;
      throw Object.assign(new Error('Save checking was cancelled.'), { code: 'codex_cancelled', writebackOutcome: outcome });
    });
    await h.retry();
    const run = h.run(), report = run.events.filter(event => event.kind === 'report').at(-1);
    assert.equal(run.settlement.documentEffect, 'changed');
    assert.deepEqual(run.settlement.fileSettlements.map(file => [file.path, file.applied]),
      [['first.tex', 'complete'], ['main.tex', 'complete']], 'settling Retry must preserve files from the original attempt');
    assert.equal(run.status, 'cancelled');
    assert.deepEqual(Array.from(run.undoOperations, operation => operation.path).sort(), ['first.tex', 'main.tex']);
    assert.equal(run.saveCheck?.files?.[0]?.path, saved ? undefined : 'main.tex');
    assert.equal(run.settlement.evidence.saved === 'verified', saved);
    assert.equal(report.detailStructured.conclusionSource.key, 'cancelled');
    assert.ok(report.detailStructured.meta.some(row => row.key === 'writeResult' && /\b1\b/.test(row.value)));
    assert.ok(report.detailStructured.meta.some(row => row.key === 'saveState'));
    const restored = State.normalizePanelState(h.snapshots.at(-1)).sessions[0].runs[0];
    assert.equal(restored.status, 'cancelled');
    assert.equal(restored.settlement.fileSettlements.length, 2);
    assert.equal(restored.undoOperations.length, 2);
  });
});

test('a cancelled Retry result and cleanup cannot change a replacement account or project record', async t => {
  for (const kind of ['account', 'project']) await t.test(kind, async () => {
    let replacement;
    const h = await retryRuntime(async runtime => {
      await runtime.stop();
      replacement = await runtime.changeScope(kind);
      throw Object.assign(new Error('Save checking was cancelled.'), { code: 'codex_cancelled',
        writebackOutcome: { operations: [runtime.operation], applied: { ok: true, applied: [], skipped: [] },
          settlement: { facts: { documentEffect: 'changed', fileSettlements: [] } } } });
    });
    await h.retry();
    assert.equal(h.run(), replacement);
    assert.equal(replacement.status, 'running', 'the old attempt must not restore its status on a new scope');
    assert.equal(replacement.events.length, 0);
    assert.equal(replacement.settlement.fileSettlements.find(file => file.path === 'main.tex').applied, 'failed');
  });
});
