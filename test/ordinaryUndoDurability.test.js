'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createPersistenceFixture } = require('./_helpers/undoPersistenceHarness');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; }

test('ordinary Undo returns only after its terminal state survives the real main persistence path', async () => {
  const h = await createPersistenceFixture();
  try {
    await h.undo();
    assert.equal(h.docs.get('main.tex').content, 'before\n');
    assert.equal(h.memory.writes, 2);
    h.disposeDocument();
    const restored = await h.load();
    assert.equal(restored.run.undoStatus, 'applied');
    assert.equal(restored.buttons.undo.disabled, true);
  } finally { h.close(); }
});

test('ordinary Undo cannot claim durable completion when the main write fails', async () => {
  const h = await createPersistenceFixture();
  try {
    h.memory.failWrites = true;
    await assert.rejects(h.undo(), /Synthetic IDB transaction failed/);
    assert.equal(h.docs.get('main.tex').content, 'before\n');
    assert.equal(h.run.undoStatus, 'partial');
    assert.notEqual(h.liveButtons().undo.text, 'Undone');
    assert.ok(h.run.undoExpectedFiles.length || h.run.undoOperations.length);
    assert.notEqual((await h.load()).run.undoStatus, 'applied');
  } finally { h.close(); }
});

test('ordinary Undo stays in flight while storage is pending and completes after commit', async () => {
  const h = await createPersistenceFixture(), entered = deferred(), release = deferred();
  let completed = false;
  try {
    h.memory.beforeWrite = async () => { entered.resolve(); await release.promise; };
    const pending = h.undo().then(() => { completed = true; });
    // The old implementation returns with only a timer. Drive that timer if
    // necessary so this test observes the commit boundary instead of hanging.
    await new Promise(resolve => setImmediate(resolve));
    if (h.timer.count()) await h.timer.next();
    await entered.promise;
    assert.equal(completed, false, 'Undo must await persistence');
    assert.notEqual(h.liveButtons().undo.text, 'Undone');
    release.resolve(); await pending;
    assert.equal(h.liveButtons().undo.text, 'Undone');
    assert.equal((await h.load()).run.undoStatus, 'applied');
  } finally { release.resolve(); h.close(); }
});

for (const outcome of ['reject', 'resolve']) test('a ' + outcome + ' after view replacement cannot roll the original Undo transition into the new view', async () => {
  const h = await createPersistenceFixture(), gate = deferred(), entered = deferred();
  try {
    h.memory.beforeWrite = async () => { entered.resolve(); await gate.promise; if (outcome === 'reject') throw new Error('old view save failed'); };
    const pending = h.undo(); const observed = assert.rejects(pending);
    await entered.promise;
    const other = { id: h.run.id, undoStatus: 'ready', task: 'new identity', undoOperations: [{ path: 'other.tex' }] };
    h.context.state = { runs: [other], sessions: [{ id: 'other-session', accountScopeId: 'other-account', projectId: 'other-project', runs: [other] }], activeSessionId: 'other-session' };
    gate.resolve(); await observed;
    assert.equal(other.undoStatus, 'ready');
    assert.equal(other.task, 'new identity');
    assert.deepEqual(other.undoOperations, [{ path: 'other.tex' }]);
  } finally { gate.resolve(); h.close(); }
});

test('ordinary Undo terminal state survives the real shared background merge and a later stale tab save', async () => {
  const { createNetwork } = require('./_helpers/sharedSessionServiceHarness');
  const Db = require('../extension/src/shared/storageDb');
  const Transaction = require('../extension/src/shared/scopedPersistenceTransaction');
  const h = await createPersistenceFixture(), network = createNetwork();
  const owner = network.client(1, h.scope.accountScopeId, h.scope.projectId), stale = network.client(2, h.scope.accountScopeId, h.scope.projectId);
  const decorate = client => client.bridge.decorate({ ...Db, getAllSessions: async () => [],
    getAllByIndex: async () => { throw new Error('local fallback is forbidden'); } });
  const ownerDb = decorate(owner), staleDb = decorate(stale);
  try {
    network.db.seed('sessions', { accountScopeId: h.scope.accountScopeId, projectId: h.scope.projectId,
      id: 'qa-session', record: h.memory.rows[0], revision: 1 });
    const staleRecord = (await staleDb.getAllByIndex('sessions', 'projectId', h.scope.projectId))[0];
    await ownerDb.getAllByIndex('sessions', 'projectId', h.scope.projectId);
    const ownerTx = Transaction.createCoordinator({ adapter: owner.adapter, writerId: 'undo-owner' });
    const staleTx = Transaction.createCoordinator({ adapter: stale.adapter, writerId: 'stale-tab' });
    await ownerTx.beginHydration(owner.scope); await staleTx.beginHydration(stale.scope);
    h.context.Modules.StorageDb = ownerDb;
    h.context.getScopedPersistenceCoordinator = () => ({ async commit(_project, options, work) {
      return ownerTx.commit(await ownerTx.captureCommitView(owner.scope), work, options);
    } });
    await h.undo();
    assert.equal(network.db.peek('sessions', [h.scope.accountScopeId, 'qa-session']).record.runs[0].undoStatus, 'applied');
    const token = await staleTx.captureCommitView(stale.scope);
    await staleTx.commit(token, () => staleDb.putRecords('sessions', [{ ...staleRecord, task: 'later stale autosave', updatedAt: '2099-01-01T00:00:00Z' }]), { rebase: true });
    const stored = network.db.peek('sessions', [h.scope.accountScopeId, 'qa-session']).record.runs[0];
    assert.equal(stored.undoStatus, 'applied');
    assert.deepEqual(stored.undoOperations, []);
  } finally { h.close(); network.close(); }
});

for (const identity of ['account', 'generation']) test('a changed ' + identity + ' during durable Undo commit rejects the stale completion', async () => {
  const h = await createPersistenceFixture(), gate = deferred(), entered = deferred();
  try {
    h.memory.beforeWrite = async () => { entered.resolve(); await gate.promise; };
    const pending = assert.rejects(h.undo(), /project, account or session changed/);
    await entered.promise;
    if (identity === 'account') h.context.cachedAccountScopeId = 'other-account'; else h.context.spaRouteGeneration++;
    const captured = JSON.stringify(h.context.state);
    gate.resolve(); await pending;
    assert.equal(JSON.stringify(h.context.state), captured, 'late completion must not rewrite a changed identity');
  } finally { gate.resolve(); h.close(); }
});
