'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { root, plain, clock } = require('./nativeReviewHarness.js');
const { runtime, timeline, Db, Scope, Undo, tr, buttons } = require('./reviewActionHarness.js');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction'));
const { harness: undoHarness } = require(path.join(root, 'test/_helpers/undoRuntimeHarness'));
const State = require(path.join(root, 'extension/src/shared/sessionState'));
const Sessions = require(path.join(root, 'extension/src/content/sessionPersistence'));
const BrowserAdapter = require(path.join(root, 'extension/src/shared/scopedPersistenceBrowserAdapter'));
const Transaction = require(path.join(root, 'extension/src/shared/scopedPersistenceTransaction'));
const Router = require(path.join(root, 'extension/src/page/writebackRouter'));
const Save = require(path.join(root, 'extension/src/page/saveState'));

async function createPersistenceFixture({ track = false, files, operations, createRouter } = {}) {
  const h = undoHarness({ track, files, operations: operations || [{ type: 'edit', path: 'main.tex',
    replaceAll: 'before\n% mixed\n', verifiedContent: 'before\n% mixed\n' }],
    createRouter: dependencies => createRouter ? createRouter(dependencies) : Router.create({ ...dependencies,
      confirmReviewWriteback: (params, result) => Save.confirmReviewWriteback({ params, result,
        getProjectId: dependencies.treeOperations.getProjectId,
        readSnapshot: async () => ({ ok: true, files: (await dependencies.projectSnapshotBridge.getProjectSnapshot()).files
          .map(file => ({ path: file.path, content: file.content, source: 'overleaf-zip' })) })
      }) })
  });
  const timer = clock(), data = {}, warnings = [], memory = { rows: [], writes: 0, failWrites: false };
  const context = h.context, scope = { accountScopeId: 'synthetic-account', projectId: 'qa-project' };
  const chromeApi = { storage: { local: {
    async get(keys) { const selected = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter(key => Object.hasOwn(data, key)).map(key => [key, plain(data[key])])); },
    async set(values) { Object.assign(data, plain(values)); }
  } } };
  const adapter = BrowserAdapter.createBrowserAdapter({ chromeApi,
    locksApi: { async request(_key, options, work) { assert.equal(options.mode, 'exclusive'); return work(); } } });
  const transaction = Transaction.createCoordinator({ adapter, writerId: 'synthetic-undo-writer' });
  await transaction.beginHydration(scope);
  let prefs = {};
  const storage = { ...Db,
    async getAllByIndex(store, key, value) { assert.equal(store, 'sessions'); assert.equal(key, 'projectId');
      return plain(memory.rows.filter(row => row.projectId === value)); },
    async putRecords(store, records) {
      assert.equal(store, 'sessions');
      if (memory.beforeWrite) await memory.beforeWrite();
      if (memory.failWrites) throw new Error('Synthetic IDB transaction failed');
      memory.writes++;
      for (const record of records) { const index = memory.rows.findIndex(row => row.id === record.id);
        if (index < 0) memory.rows.push(plain(record)); else memory.rows[index] = plain(record); }
      return plain(records);
    },
    async deleteRecord() { throw new Error('unexpected history deletion'); }
  };
  const migration = { async loadPrefs() { return plain(prefs); }, async savePrefs(value) { prefs = plain(value); },
    async loadSessionTombstones() { return {}; }, getDeletedSessionIds() { return []; },
    async runMigrationIfNeeded(project, _key, account) { return { prefs: plain(prefs),
      sessions: plain(memory.rows.filter(row => row.projectId === project && row.accountScopeId === account)),
      activeSessionId: prefs.activeSessionByProject?.[project] || '' }; }
  };
  context.state.activeSessionId = 'qa-session';
  Object.assign(context.state.sessions[0], { accountScopeId: scope.accountScopeId,
    createdAt: '2026-09-28T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z' });
  Object.assign(context.Modules, { SessionState: State, StorageDb: storage, StorageMigration: migration, SessionPersistence: Sessions, ScopedPersistenceCoordinator: Scope });
  Object.assign(context, { currentRunView: null, cachedAccountScopeId: scope.accountScopeId,
    storageKey: 'synthetic-legacy-qa-project', getCurrentProjectId: () => h.state.projectId, spaRouteGeneration: 0,
    getAccountScopeId: () => context.cachedAccountScopeId, getRouteGeneration: () => context.spaRouteGeneration,
    prepareStateForStorage: State.prepareStateForStorage, notifyAggressiveCompactionOnce() {},
    getCodexOverleafSkillEnabled: () => ({}), normalizeExperimentalOtByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    getComposerDraftPersistence: () => ({ async save() {}, async load() { return []; } }),
    getScopedPersistenceCoordinator: () => ({ async commit(projectId, options, action) {
      const captured = { accountScopeId: context.cachedAccountScopeId, projectId };
      return transaction.commit(await transaction.captureCommitView(captured), action, options);
    } }),
    chrome: chromeApi, saveStateTimer: null, saveStateInFlight: false, saveStateRunAfterFlight: false,
    saveStateInFlightPromise: null, pendingSaveStateOptions: null, storageNoticeKeys: new Set(),
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    appendPlainLog: value => warnings.push(String(value)), showPluginToast: value => warnings.push(String(value)),
    tr, tx: value => value, PANEL_DEFAULT_WIDTH: 380,
    isScopedPersistenceIdentityFailure: error => ['account_scope_unavailable','stale_hydration'].includes(error?.code)
  });
  for (const name of ['readLiveRunViewForSaveStateGuard','saveState','saveStateSoon','runQueuedSaveState','flushQueuedSaveState',
    'mergeSaveStateOptions','prepareCompactFallbackState','buildScopedFallbackStorageKey','isStorageQuotaError',
    'formatStateSaveError','appendStorageNoticeOnce','loadStoredStateForProject','loadComposerAttachmentsForProject','setRunUndoStatus']) {
    vm.runInContext(extractFunction(runtime, name), context);
  }
  for (const name of ['buildTrackedUndoPostFiles','hasTrackedEditorUndo']) vm.runInContext(extractFunction(runtime, name), context);
  vm.runInContext(extractFunction(timeline, 'isTrackedChangeLifecycleRun'), context);
  await context.saveState({ requireDurable: true });
  assert.equal(memory.writes, 1);
  const load = async () => {
    const loaded = await context.loadStoredStateForProject(scope.accountScopeId);
    const restored = State.normalizePanelState(loaded, { restoreRunningRuns: true });
    const run = restored.runs.find(row => row.id === h.run.id);
    assert.ok(run, 'actual load projection must restore the run');
    return { run, buttons: buttons(run), state: restored };
  };
  return { ...h, timer, warnings, memory, data, scope, storage,
    load, liveButtons: () => buttons(h.run, { trackedChangeInFlight: context.trackedChangeInFlight }),
    savedRun: () => memory.rows.flatMap(row => row.runs).find(run => run.id === h.run.id),
    disposeDocument() { timer.clear(); },
    close() { timer.clear(); }
  };
}
module.exports = { createPersistenceFixture };
