const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/sessionPersistence.js'),
  'utf8'
);

function loadModule(Migration) {
  const window = { CodexOverleafStorageMigration: Migration };
  vm.runInNewContext(source, { window, console });
  return window.CodexOverleafSessionPersistence;
}

test('session persistence cannot mutate records owned by another account', async () => {
  const writes = [];
  const deletes = [];
  const Migration = {
    async loadSessionTombstones() {
      return {};
    },
    getDeletedSessionIds() {
      return [];
    }
  };
  const Persistence = loadModule(Migration);
  const StorageDb = {
    async getAllByIndex() {
      return [
        {
          id: 'session-a',
          projectId: 'project-1',
          accountScopeId: 'account-a',
          updatedAt: '2026-07-27T00:00:00.000Z',
          pendingInputs: []
        },
        {
          id: 'session-b',
          projectId: 'project-1',
          accountScopeId: 'account-b',
          updatedAt: '2026-07-27T00:00:00.000Z',
          pendingInputs: [{ id: 'queue-b' }]
        }
      ];
    },
    async putRecords(_store, records) {
      writes.push(...records);
    },
    async deleteRecord(_store, id) {
      deletes.push(id);
    }
  };

  await Persistence.writeSessions({
    StorageDb,
    Migration,
    projectId: 'project-1',
    accountScopeId: 'account-a',
    sessionRecords: [{
      id: 'session-a',
      projectId: 'project-1',
      accountScopeId: 'account-a',
      updatedAt: '2026-07-27T00:00:01.000Z',
      pendingInputs: []
    }],
    queueTombstones: { 'queue-b': true },
    deletedSessionIds: ['session-b']
  });

  assert.equal(writes.some(record => record.accountScopeId === 'account-b'), false);
  assert.deepEqual(deletes, []);
});
