const assert = require('node:assert/strict');
const test = require('node:test');

const Persistence = require('../extension/src/content/postNavigationSettlementPersistence');
const Settlement = require('../extension/src/shared/writebackSettlement');

test('post-navigation persistence applies canonical settlement and recovery to the original run', async () => {
  const record = {
    id: 'session-a',
    projectId: 'project-a',
    accountScopeId: 'account-a',
    runs: [{
      id: 'run-a',
      status: 'running',
      trackedChangeStatus: 'pending',
      undoTrackedChanges: [{ id: 'change-1', path: 'main.tex' }],
      undoExpectedFiles: [{ path: 'main.tex', content: 'before' }]
    }]
  };
  let written = null;
  let detachedCommit = null;
  const StorageDb = {
    async getRecord(store, id) {
      assert.equal(store, 'sessions');
      assert.equal(id, 'session-a');
      return structuredClone(record);
    },
    async putRecord(store, value) {
      assert.equal(store, 'sessions');
      written = value;
    }
  };
  const PersistenceCoordinator = {
    async commitDetached(projectId, accountScopeId, options, action) {
      detachedCommit = { projectId, accountScopeId, options };
      return action();
    }
  };

  const result = await Persistence.persist({
    StorageDb,
    PersistenceCoordinator,
    WritebackSettlement: Settlement,
    projectId: 'project-a',
    accountScopeId: 'account-a',
    sessionId: 'session-a',
    runId: 'run-a',
    status: 'background_completed',
    statusText: 'Completed in background',
    finishedAt: '2026-07-26T12:00:00.000Z',
    settlementResult: Settlement.transitionTrackedChangeStatus('accepted'),
    now: '2026-07-26T12:00:01.000Z'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(detachedCommit, {
    projectId: 'project-a',
    accountScopeId: 'account-a',
    options: { rebase: true }
  });
  const run = written.runs[0];
  assert.equal(run.status, 'background_completed');
  assert.equal(run.trackedChangeStatus, 'accepted');
  assert.deepEqual(run.undoTrackedChanges, []);
  assert.deepEqual(run.undoExpectedFiles, []);
  assert.equal(run.settlement.evidence.settled, 'complete');
  assert.equal(written.updatedAt, '2026-07-26T12:00:01.000Z');
});

test('post-navigation persistence fails closed without the original account scope', async () => {
  let storageRead = false;
  const result = await Persistence.persist({
    StorageDb: {
      async getRecord() {
        storageRead = true;
        return null;
      }
    },
    PersistenceCoordinator: {
      async commitDetached() {
        throw new Error('must not begin an unscoped transaction');
      }
    },
    WritebackSettlement: Settlement,
    projectId: 'project-a',
    accountScopeId: '',
    sessionId: 'session-a',
    runId: 'run-a',
    status: 'background_completed',
    statusText: 'Completed in background',
    finishedAt: '2026-07-26T12:00:00.000Z',
    settlementResult: Settlement.transitionTrackedChangeStatus('accepted'),
    now: '2026-07-26T12:00:01.000Z'
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'account_scope_unavailable'
  });
  assert.equal(storageRead, false);
});

test('required post-navigation persistence promotes a fail-closed result to a structured failure', async () => {
  await assert.rejects(
    Persistence.persistRequired({
      projectId: 'project-a',
      accountScopeId: ''
    }),
    error => {
      assert.equal(error.code, 'post_navigation_settlement_persistence_failed');
      assert.equal(error.reason, 'account_scope_unavailable');
      return true;
    }
  );
});

test('post-navigation persistence rejects a session record from another scope', async () => {
  let written = false;
  const StorageDb = {
    async getRecord() {
      return {
        id: 'session-a',
        projectId: 'project-b',
        accountScopeId: 'account-b',
        runs: [{ id: 'run-a', status: 'running' }]
      };
    },
    async putRecord() {
      written = true;
    }
  };
  const PersistenceCoordinator = {
    async commitDetached(_projectId, _accountScopeId, _options, action) {
      return action();
    }
  };

  const accountMismatch = await Persistence.persist({
    StorageDb,
    PersistenceCoordinator,
    WritebackSettlement: Settlement,
    projectId: 'project-a',
    accountScopeId: 'account-a',
    sessionId: 'session-a',
    runId: 'run-a',
    status: 'background_completed'
  });
  assert.deepEqual(accountMismatch, { ok: false, reason: 'account_scope_mismatch' });
  assert.equal(written, false);

  StorageDb.getRecord = async () => ({
    id: 'session-a',
    projectId: 'project-b',
    accountScopeId: 'account-a',
    runs: [{ id: 'run-a', status: 'running' }]
  });
  const projectMismatch = await Persistence.persist({
    StorageDb,
    PersistenceCoordinator,
    WritebackSettlement: Settlement,
    projectId: 'project-a',
    accountScopeId: 'account-a',
    sessionId: 'session-a',
    runId: 'run-a',
    status: 'background_completed'
  });
  assert.deepEqual(projectMismatch, { ok: false, reason: 'project_scope_mismatch' });
  assert.equal(written, false);
});
