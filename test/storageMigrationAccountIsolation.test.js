const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const Migration = require('../extension/src/shared/storageMigration');
const registrySource = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/moduleRegistryKernel.js'),
  'utf8'
);
const migrationSource = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/storageMigration.js'),
  'utf8'
);

function loadMigration(StorageDb, chromeApi) {
  const window = { CodexOverleafStorageDb: StorageDb };
  vm.runInNewContext(
    `${registrySource}\n${migrationSource}`,
    { window, globalThis: window, chrome: chromeApi, console }
  );
  return window.CodexOverleafStorageMigration;
}

test('current-schema hydration returns only the requested account and claims legacy sessions once', async () => {
  const previousWindow = global.window;
  const previousChrome = global.chrome;
  const persisted = [];
  const records = [
    { id: 'session-a', projectId: 'project-1', accountScopeId: 'account-a' },
    { id: 'session-b', projectId: 'project-1', accountScopeId: 'account-b' },
    { id: 'session-legacy', projectId: 'project-1' }
  ];
  global.window = {
    CodexOverleafStorageDb: {
      TARGET_SCHEMA_VERSION: 1,
      async claimSessionsForAccount(projectId, accountScopeId, deletedSessionIds) {
        assert.equal(projectId, 'project-1');
        assert.deepEqual(Array.from(deletedSessionIds), []);
        const visible = [];
        for (const record of records) {
          if (record.projectId !== projectId) continue;
          if (record.accountScopeId === accountScopeId) visible.push(structuredClone(record));
          else if (!record.accountScopeId) {
            record.accountScopeId = accountScopeId;
            persisted.push(structuredClone(record));
            visible.push(structuredClone(record));
          }
        }
        return visible;
      }
    }
  };
  global.chrome = {
    storage: {
      local: {
        async get() {
          return {
            [Migration.PREFS_KEY]: {
              storageSchemaVersion: 1,
              activeSessionByProject: { 'project-1': 'session-a' }
            }
          };
        },
        async set() {}
      }
    }
  };

  try {
    const ScopedMigration = loadMigration(global.window.CodexOverleafStorageDb, global.chrome);
    const result = await ScopedMigration.runMigrationIfNeeded(
      'project-1',
      'legacy-key',
      'account-b'
    );

    assert.deepEqual(result.sessions.map(session => session.id), [
      'session-b',
      'session-legacy'
    ]);
    assert.equal(result.sessions.every(session => session.accountScopeId === 'account-b'), true);
    assert.deepEqual(persisted, [{
      id: 'session-legacy',
      projectId: 'project-1',
      accountScopeId: 'account-b'
    }]);
    assert.equal(result.activeSessionId, 'session-legacy');
  } finally {
    global.window = previousWindow;
    global.chrome = previousChrome;
  }
});

test('concurrent account hydration can claim an unscoped legacy session only once', async () => {
  const previousWindow = global.window;
  const previousChrome = global.chrome;
  const records = [{ id: 'session-legacy', projectId: 'project-1' }];
  let transactionTail = Promise.resolve();
  const StorageDb = {
    TARGET_SCHEMA_VERSION: 1,
    claimSessionsForAccount(projectId, accountScopeId) {
      const transaction = transactionTail.then(async () => {
        await Promise.resolve();
        const visible = [];
        for (const record of records) {
          if (record.projectId !== projectId) continue;
          if (!record.accountScopeId) record.accountScopeId = accountScopeId;
          if (record.accountScopeId === accountScopeId) visible.push(structuredClone(record));
        }
        return visible;
      });
      transactionTail = transaction.then(() => undefined, () => undefined);
      return transaction;
    }
  };
  global.window = { CodexOverleafStorageDb: StorageDb };
  global.chrome = {
    storage: {
      local: {
        async get() {
          return {
            [Migration.PREFS_KEY]: {
              storageSchemaVersion: 1,
              activeSessionByProject: {}
            }
          };
        }
      }
    }
  };

  try {
    const ScopedMigration = loadMigration(StorageDb, global.chrome);
    const [accountA, accountB] = await Promise.all([
      ScopedMigration.runMigrationIfNeeded('project-1', 'legacy-key', 'account-a'),
      ScopedMigration.runMigrationIfNeeded('project-1', 'legacy-key', 'account-b')
    ]);
    const owners = [accountA, accountB]
      .filter(result => result.sessions.some(session => session.id === 'session-legacy'));
    assert.equal(owners.length, 1);
    assert.equal(records[0].accountScopeId, owners[0].sessions[0].accountScopeId);
  } finally {
    global.window = previousWindow;
    global.chrome = previousChrome;
  }
});

test('content hydration passes its frozen account scope into storage migration', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  assert.match(
    source,
    /runMigrationIfNeeded\(\s*projectId,\s*legacyKey,\s*accountScopeId\s*\)/
  );
});

test('project preferences remain isolated for two accounts on the same project', async () => {
  const previousChrome = global.chrome;
  let stored = {};
  global.chrome = {
    storage: {
      local: {
        async get() {
          return structuredClone(stored);
        },
        async set(payload) {
          stored = { ...stored, ...structuredClone(payload) };
        }
      }
    }
  };

  try {
    await Migration.savePrefs({
      locale: 'en',
      activeSessionByProject: { 'project-1': 'session-a' },
      experimentalOtByProject: { 'project-1': true },
      customInstructionsByProject: { 'project-1': 'account-a-only' }
    }, 'account-a', 'project-1');
    await Migration.savePrefs({
      locale: 'en',
      activeSessionByProject: { 'project-1': 'session-b' },
      experimentalOtByProject: { 'project-1': false },
      customInstructionsByProject: { 'project-1': 'account-b-only' }
    }, 'account-b', 'project-1');

    const accountA = await Migration.loadPrefs('account-a', 'project-1');
    const accountB = await Migration.loadPrefs('account-b', 'project-1');
    const accountAKey = Migration.buildScopedProjectPreferenceKey('account-a', 'project-1');
    const accountBKey = Migration.buildScopedProjectPreferenceKey('account-b', 'project-1');
    const rawPrefs = stored[Migration.PREFS_KEY];

    assert.equal(accountA.activeSessionByProject['project-1'], 'session-a');
    assert.equal(accountB.activeSessionByProject['project-1'], 'session-b');
    assert.equal(accountA.customInstructionsByProject['project-1'], 'account-a-only');
    assert.equal(accountB.customInstructionsByProject['project-1'], 'account-b-only');
    assert.equal(rawPrefs.activeSessionByProject[accountAKey], 'session-a');
    assert.equal(rawPrefs.activeSessionByProject[accountBKey], 'session-b');
    assert.equal(Object.hasOwn(rawPrefs.activeSessionByProject, 'project-1'), false);
  } finally {
    global.chrome = previousChrome;
  }
});

test('a legacy unscoped project preference is claimed by only one concurrent account', async () => {
  const previousChrome = global.chrome;
  let stored = {
    [Migration.PREFS_KEY]: {
      storageSchemaVersion: 1,
      customInstructionsByProject: { 'project-1': 'legacy-private-value' }
    }
  };
  global.chrome = {
    storage: {
      local: {
        async get() {
          await Promise.resolve();
          return structuredClone(stored);
        },
        async set(payload) {
          stored = { ...stored, ...structuredClone(payload) };
        }
      }
    }
  };

  try {
    const [accountA, accountB] = await Promise.all([
      Migration.loadPrefs('account-a', 'project-1'),
      Migration.loadPrefs('account-b', 'project-1')
    ]);
    const owners = [accountA, accountB].filter(prefs =>
      prefs.customInstructionsByProject['project-1'] === 'legacy-private-value'
    );

    assert.equal(owners.length, 1);
  } finally {
    global.chrome = previousChrome;
  }
});
