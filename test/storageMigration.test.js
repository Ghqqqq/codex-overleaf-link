const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Migration = require('../extension/src/shared/storageMigration');
const StorageDbModule = require('../extension/src/shared/storageDb');
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

test('storageMigration exports PREFS_KEY', () => {
  assert.strictEqual(Migration.PREFS_KEY, 'codexOverleafPrefs');
});

test('storageMigration exports runMigrationIfNeeded', () => {
  assert.strictEqual(typeof Migration.runMigrationIfNeeded, 'function');
});

test('storageMigration exports savePrefs', () => {
  assert.strictEqual(typeof Migration.savePrefs, 'function');
});

test('storageMigration exports loadPrefs', () => {
  assert.strictEqual(typeof Migration.loadPrefs, 'function');
});

test('loadPrefs defaults missing experimental OT map to an empty object', async () => {
  const previousChrome = global.chrome;
  global.chrome = {
    storage: {
      local: {
        get() {
          return Promise.resolve({ [Migration.PREFS_KEY]: { storageSchemaVersion: 1 } });
        }
      }
    }
  };

  try {
    const prefs = await Migration.loadPrefs();
    assert.deepEqual(prefs.experimentalOtByProject, {});
    assert.deepEqual(prefs.customInstructionsByProject, {});
  } finally {
    global.chrome = previousChrome;
  }
});

test('savePrefs normalizes custom instruction project prefs', async () => {
  const calls = [];
  const previousChrome = global.chrome;
  global.chrome = {
    storage: {
      local: {
        set(payload) {
          calls.push(payload);
          return Promise.resolve();
        }
      }
    }
  };

  try {
    await Migration.savePrefs({
      storageSchemaVersion: 1,
      customInstructionsByProject: {
        project_1: 'Use project terminology.',
        project_2: 42,
        '': 'ignored'
      }
    });

    assert.deepEqual(calls[0][Migration.PREFS_KEY].customInstructionsByProject, {
      project_1: 'Use project terminology.',
      project_2: ''
    });
  } finally {
    global.chrome = previousChrome;
  }
});

test('current-schema migration load path normalizes experimental OT map values', async () => {
  const writes = [];
  const previousWindow = global.window;
  const previousChrome = global.chrome;
  const fakeStorageDb = {
    TARGET_SCHEMA_VERSION: 1,
    claimSessionsForAccount() {
      return Promise.resolve([]);
    },
    getAllByIndex() {
      return Promise.resolve([]);
    }
  };
  global.window = { CodexOverleafStorageDb: fakeStorageDb };
  global.chrome = {
    storage: {
      local: {
        get() {
          return Promise.resolve({
            [Migration.PREFS_KEY]: {
              storageSchemaVersion: 1,
              activeSessionByProject: { project_1: 'session_1' },
              experimentalOtByProject: {
                project_1: true,
                project_2: 0,
                project_3: 'yes',
                project_4: {},
                project_5: []
              },
              customInstructionsByProject: {
                project_1: 'Prefer \\cref{}.',
                project_2: 0,
                project_3: [],
                '': 'ignored'
              }
            }
          });
        },
        set(payload) {
          writes.push(payload);
          return Promise.resolve();
        }
      }
    }
  };

  try {
    const ScopedMigration = loadMigration(fakeStorageDb, global.chrome);
    const result = await ScopedMigration.runMigrationIfNeeded('project_1', 'legacy', 'account-1');
    assert.equal(result.migrated, false);
    assert.deepEqual(result.prefs.experimentalOtByProject, {
      project_1: true
    });
    assert.deepEqual(result.prefs.customInstructionsByProject, {
      project_1: 'Prefer \\cref{}.'
    });
    const scopedPrefsKey = Migration.buildScopedProjectPreferenceKey('account-1', 'project_1');
    const prefsWrites = writes.filter((payload) => payload[Migration.PREFS_KEY]);
    const persistedPrefs = prefsWrites[prefsWrites.length - 1][Migration.PREFS_KEY];
    assert.equal(persistedPrefs.experimentalOtByProject[scopedPrefsKey], true);
    assert.equal(persistedPrefs.customInstructionsByProject[scopedPrefsKey], 'Prefer \\cref{}.');
    assert.equal(result.activeSessionId, '');
  } finally {
    global.window = previousWindow;
    global.chrome = previousChrome;
  }
});

test('migration preserves legacy session display fields and settings', async () => {
  const calls = {
    putRecords: [],
    set: [],
    remove: []
  };
  const legacyStorageKey = 'codexOverleafPanelState:project_1';
  const legacyBlob = {
    model: 'gpt-5.3-codex-spark',
    reasoningEffort: 'xhigh',
    mode: 'auto',
    requireReviewing: false,
    experimentalOtByProject: { project_1: true },
    customInstructionsByProject: {
      project_1: 'Use ACL style.',
      project_2: 123,
      '': 'ignored'
    },
    activeSessionId: 'session_legacy',
    sessions: [{
      id: 'session_legacy',
      title: 'Fix grammar',
      task: '帮我检查语法错误',
      mode: 'auto',
      model: 'gpt-5.3-codex-spark',
      reasoningEffort: 'xhigh',
      requireReviewing: false,
      focusFiles: ['paper.tex'],
      history: [{ task: '上一轮', result: '改了引言', at: '2026-05-02T02:00:00.000Z' }],
      runs: [{
        id: 'run_legacy',
        task: '帮我检查语法错误',
        status: 'completed',
        events: [{ title: '本轮完成报告', status: 'completed' }]
      }],
      createdAt: '2026-05-02T01:00:00.000Z',
      updatedAt: '2026-05-02T02:00:00.000Z'
    }]
  };
  const fakeStorageDb = {
    TARGET_SCHEMA_VERSION: 1,
    buildSessionRecord(input) {
      return { ...input };
    },
    putRecords(storeName, records) {
      calls.putRecords.push({ storeName, records });
      return Promise.resolve(records);
    },
    getAllByIndex() {
      return Promise.resolve([]);
    },
    extractLightweightPrefs(blob) {
      return {
        storageSchemaVersion: 1,
        model: blob.model,
        reasoningEffort: blob.reasoningEffort,
        mode: blob.mode,
        requireReviewing: blob.requireReviewing !== false,
        experimentalOtByProject: blob.experimentalOtByProject || {},
        customInstructionsByProject: blob.customInstructionsByProject || {},
        activeSessionByProject: {}
      };
    },
    buildActiveSessionByProject(existing, projectId, sessionId) {
      return { ...existing, [projectId]: sessionId };
    }
  };
  const previousWindow = global.window;
  const previousChrome = global.chrome;
  global.window = { CodexOverleafStorageDb: fakeStorageDb };
  global.chrome = {
    storage: {
      local: {
        get() {
          return Promise.resolve({ [legacyStorageKey]: legacyBlob });
        },
        set(payload) {
          calls.set.push(payload);
          return Promise.resolve();
        },
        remove(key) {
          calls.remove.push(key);
          return Promise.resolve();
        }
      }
    }
  };

  try {
    const ScopedMigration = loadMigration(fakeStorageDb, global.chrome);
    const result = await ScopedMigration.runMigrationIfNeeded('project_1', legacyStorageKey, 'account-1');
    const [record] = calls.putRecords[0].records;

    assert.equal(result.migrated, true);
    assert.equal(record.id, 'session_legacy');
    assert.equal(record.task, '帮我检查语法错误');
    assert.equal(record.mode, 'auto');
    assert.equal(record.model, 'gpt-5.3-codex-spark');
    assert.equal(record.reasoningEffort, 'xhigh');
    assert.equal(record.requireReviewing, false);
    assert.deepEqual(record.focusFiles, ['paper.tex']);
    assert.equal(record.history[0].task, '上一轮');
    assert.equal(record.history[0].result, '改了引言');
    assert.equal(record.runs[0].id, 'run_legacy');
    assert.equal(record.runs[0].task, '帮我检查语法错误');
    assert.equal(record.runs[0].events[0].title, '本轮完成报告');
    assert.equal(record.runs[0].events[0].status, 'completed');
    assert.deepEqual(result.prefs.experimentalOtByProject, { project_1: true });
    assert.deepEqual(result.prefs.customInstructionsByProject, {
      project_1: 'Use ACL style.'
    });
    const scopedPrefsKey = Migration.buildScopedProjectPreferenceKey('account-1', 'project_1');
    const prefsWrites = calls.set.filter((payload) => payload[Migration.PREFS_KEY]);
    const persistedPrefs = prefsWrites[prefsWrites.length - 1][Migration.PREFS_KEY];
    assert.equal(persistedPrefs.experimentalOtByProject[scopedPrefsKey], true);
    assert.equal(persistedPrefs.customInstructionsByProject[scopedPrefsKey], 'Use ACL style.');
    assert.equal(calls.remove[0], legacyStorageKey);
  } finally {
    global.window = previousWindow;
    global.chrome = previousChrome;
  }
});

test('migration strips bulky legacy payloads while preserving displayable history', async () => {
  const calls = {
    putRecords: [],
    set: [],
    remove: []
  };
  const legacyStorageKey = 'codexOverleafPanelState:project_privacy';
  const markers = [
    'LEGACY_RAW_DIFF_SHOULD_NOT_PERSIST',
    'LEGACY_PROJECT_TEXT_SHOULD_NOT_PERSIST',
    'data:image/png;base64,LEGACY_IMAGE_SHOULD_NOT_PERSIST'
  ];
  const legacyBlob = {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    mode: 'confirm',
    sessions: [{
      id: 'session_legacy_privacy',
      title: 'LEGACY_PROMPT_SHOULD_NOT_PERSIST from task',
      titleSource: 'auto',
      task: 'LEGACY_PROMPT_SHOULD_NOT_PERSIST',
      focusFiles: ['main.tex'],
      history: [{
        task: 'LEGACY_PROMPT_SHOULD_NOT_PERSIST',
        result: 'LEGACY_OUTPUT_SHOULD_NOT_PERSIST',
        at: '2026-05-02T02:00:00.000Z'
      }],
      runs: [{
        id: 'run_legacy_privacy',
        task: 'LEGACY_PROMPT_SHOULD_NOT_PERSIST',
        status: 'failed',
        statusText: 'LEGACY_OUTPUT_SHOULD_NOT_PERSIST',
        startedAt: '2026-05-02T01:00:00.000Z',
        finishedAt: '2026-05-02T02:00:00.000Z',
        events: [{
          title: 'LEGACY_COMPILE_LOG_SHOULD_NOT_PERSIST',
          status: 'failed',
          kind: 'report',
          detail: {
            output: 'LEGACY_OUTPUT_SHOULD_NOT_PERSIST',
            compileLog: 'LEGACY_COMPILE_LOG_SHOULD_NOT_PERSIST',
            rawDiff: 'LEGACY_RAW_DIFF_SHOULD_NOT_PERSIST',
            projectText: 'LEGACY_PROJECT_TEXT_SHOULD_NOT_PERSIST',
            path: 'main.tex'
          }
        }],
        attachments: [{
          name: 'figure.png',
          mimeType: 'image/png',
          size: 128,
          kind: 'image',
          previewDataUrl: 'data:image/png;base64,LEGACY_IMAGE_SHOULD_NOT_PERSIST'
        }],
        undoOperations: [{
          type: 'edit',
          path: 'main.tex',
          replaceAll: 'LEGACY_RAW_DIFF_SHOULD_NOT_PERSIST'
        }],
        undoBaseFiles: [{ path: 'main.tex', content: 'LEGACY_PROJECT_TEXT_SHOULD_NOT_PERSIST' }],
        undoExpectedFiles: [{ path: 'main.tex', content: 'LEGACY_PROJECT_TEXT_SHOULD_NOT_PERSIST' }]
      }],
      createdAt: '2026-05-02T01:00:00.000Z',
      updatedAt: '2026-05-02T02:00:00.000Z'
    }]
  };
  const fakeStorageDb = {
    TARGET_SCHEMA_VERSION: 2,
    buildSessionRecord(input) {
      return StorageDbModule.buildSessionRecord(input);
    },
    putRecords(storeName, records) {
      calls.putRecords.push({ storeName, records });
      return Promise.resolve(records);
    },
    extractLightweightPrefs() {
      return { storageSchemaVersion: 2, activeSessionByProject: {} };
    },
    buildActiveSessionByProject(existing, projectId, sessionId) {
      return { ...existing, [projectId]: sessionId };
    }
  };
  const previousWindow = global.window;
  const previousChrome = global.chrome;
  global.window = { CodexOverleafStorageDb: fakeStorageDb };
  global.chrome = {
    storage: {
      local: {
        get() {
          return Promise.resolve({ [legacyStorageKey]: legacyBlob });
        },
        set(payload) {
          calls.set.push(payload);
          return Promise.resolve();
        },
        remove(key) {
          calls.remove.push(key);
          return Promise.resolve();
        }
      }
    }
  };

  try {
    const ScopedMigration = loadMigration(fakeStorageDb, global.chrome);
    const result = await ScopedMigration.runMigrationIfNeeded(
      'project_privacy',
      legacyStorageKey,
      'account-1'
    );
    const persisted = JSON.stringify({
      result,
      putRecords: calls.putRecords
    });

    for (const marker of markers) {
      assert.equal(persisted.includes(marker), false, `migration leaked ${marker}`);
    }
    assert.equal(calls.putRecords[0].storeName, 'sessions');
    const record = calls.putRecords[0].records[0];
    assert.equal(record.id, 'session_legacy_privacy');
    assert.equal(record.task, 'LEGACY_PROMPT_SHOULD_NOT_PERSIST');
    assert.equal(record.history[0].result, 'LEGACY_OUTPUT_SHOULD_NOT_PERSIST');
    assert.equal(record.runs[0].statusText, 'LEGACY_OUTPUT_SHOULD_NOT_PERSIST');
    assert.equal(record.runs[0].events[0].title, 'LEGACY_COMPILE_LOG_SHOULD_NOT_PERSIST');
    assert.equal(record.runs[0].events[0].detail.redacted, true);
    assert.deepEqual(record.runs[0].events[0].detail.paths, ['main.tex']);
    assert.equal(record.runs[0].attachments[0].previewDataUrl, undefined);
    assert.equal(record.runs[0].undoOperations.length, 0);
  } finally {
    global.window = previousWindow;
    global.chrome = previousChrome;
  }
});
