'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { root, plain, read, deferred, drain, createNetwork, clockedViewSync } = require('./sharedSessionServiceHarness');
const { extractFunction } = require(path.join(root, 'test/_helpers/extractFunction.js'));
const { harness } = require(path.join(root, 'test/_helpers/runSubmissionHarness.js'));
const State = require(path.join(root, 'extension/src/shared/sessionState.js'));
const RawDb = require(path.join(root, 'extension/src/shared/storageDb.js'));
const Persistence = require(path.join(root, 'extension/src/content/sessionPersistence.js'));
const PanelState = require(path.join(root, 'extension/src/content/scopedPersistencePanelState.js'));
const Transaction = require(path.join(root, 'extension/src/shared/scopedPersistenceTransaction.js'));
const GlobalPreferencesController = require(path.join(root, 'extension/src/content/globalPreferencesController.js'));
const runtime = read('extension/src/content/contentRuntime.js');
const no = () => {};
function session(changes = {}) {
  return RawDb.buildSessionRecord({ id: 'A', projectId: 'project-one', accountScopeId: 'account-one',
    title: 'Original title', titleSource: 'manual', task: '', mode: 'ask', model: 'fixture-model',
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    history: [], runs: [], pendingInputs: [], ...changes });
}
const remoteRun = { id: 'remote-run', task: 'remote completed task', status: 'completed',
  providerRevision: 0, events: [], startedAt: '2026-09-28T00:00:01.000Z', finishedAt: '2026-09-28T00:00:02.000Z' };
function decorated(client) {
  return client.bridge.decorate({ ...RawDb, getAllSessions: async () => [],
    getAllByIndex: async () => { throw new Error('origin-local session fallback forbidden'); } });
}
async function refreshLab() {
  const network = createNetwork(), observer = network.client(1), peer = network.client(2);
  const initial = session();
  network.db.seed('sessions', { accountScopeId: 'account-one', projectId: 'project-one', id: 'A', record: initial, revision: 1 });
  const observerDb = decorated(observer), peerDb = decorated(peer);
  const stored = await observerDb.getAllByIndex('sessions', 'projectId', 'project-one');
  const observerTransaction = Transaction.createCoordinator({ adapter: observer.adapter, writerId: 'synthetic-observer' });
  const peerTransaction = Transaction.createCoordinator({ adapter: peer.adapter, writerId: 'synthetic-peer' });
  await observerTransaction.beginHydration(observer.scope);
  await peerTransaction.beginHydration(peer.scope);
  const h = harness(), notices = [], display = { runs: [] }, commitResults = [];
  h.context.state = State.normalizePanelState({ sessions: stored, activeSessionId: 'A' }, { restoreRunningRuns: false });
  h.context.normalizePanelState = State.normalizePanelState;
  h.context.spaRouteGeneration = 0;
  h.context.document.querySelector = () => null;
  h.context.renderRunHistory = () => { display.runs = h.context.state.runs.map(run => run.id); };
  h.context.appendStorageNoticeOnce = (code, message) => notices.push({ code, message });
  for (const name of ['readLiveRunViewForSaveStateGuard', 'saveState', 'persistPanelInputs']) vm.runInContext(extractFunction(runtime, name), h.context);
  let prefs = {};
  const globalPreferences = GlobalPreferencesController.create({
    chromeApi: { runtime: { sendMessage: async () => { throw new Error('unexpected global preference route'); } } },
    getState: () => h.context.state, setState: value => { h.context.state = value; }, getPanel: () => h.context.panel
  });
  const Migration = { loadPrefs: async () => plain(prefs), savePrefs: async value => { prefs = plain(value); },
    loadSessionTombstones: async () => ({}), getDeletedSessionIds: () => [] };
  Object.assign(h.context.Modules, { StorageDb: observerDb, StorageMigration: Migration,
    SessionPersistence: Persistence, ScopedPersistenceCoordinator: PanelState });
  Object.assign(h.context, { prepareStateForStorage: State.prepareStateForStorage,
    notifyAggressiveCompactionOnce: no, getCodexOverleafSkillEnabled: () => ({}), getCodexLocalSkillEnabled: () => ({}),
    normalizeExperimentalOtByProject: value => value || {}, normalizeGovernanceRulesByProject: value => value || {},
    normalizeCustomInstructionsByProject: value => value || {},
    getGlobalPreferences: () => globalPreferences,
    getScopedPersistenceCoordinator: () => ({ async commit(projectId, options, persist) {
      assert.equal(projectId, 'project-one');
      const token = await observerTransaction.captureCommitView(observer.scope);
      const result = await observerTransaction.commit(token, persist, options);
      commitResults.push({ ok: result.ok, rebased: result.rebased, revision: result.revision, durableRevision: result.durableRevision });
      return result;
    } }) });
  h.context.applyStateToPanel();
  const clock = clockedViewSync();
  Object.assign(h.context.Modules, { SharedSessionBridge: observer.bridge, SharedSessionViewSync: clock.api });
  const start = runtime.indexOf('  var sharedSessionViewSync = Modules.SharedSessionViewSync.install({');
  assert.ok(start >= 0);
  const end = runtime.indexOf('\n  });', start) + '\n  });'.length;
  const composition = runtime.slice(start, end);
  assert.match(composition, /(?:apply:|render: applyStateToPanel)/);
  vm.runInContext(composition, h.context);
  const stateSummary = () => ({ title: h.context.state.sessions.find(s => s.id === h.context.state.activeSessionId).title, task: h.context.state.task,
    runIds: h.context.state.runs.map(run => run.id) });
  const finalStored = () => network.db.peek('sessions', ['account-one', 'A']).record;
  return { network, observer, peer, observerDb, peerDb, h, clock, display, notices, commitResults, stateSummary, finalStored,
    async peerUpdate(changes = {}) {
      const original = (await peerDb.getAllByIndex('sessions', 'projectId', 'project-one'))[0];
      const record = peerDb.buildSessionRecord({ ...original, title: 'Remote title', runs: [remoteRun],
        updatedAt: '2026-09-28T00:00:02.000Z', ...changes });
      const token = await peerTransaction.captureCommitView(peer.scope);
      await peerTransaction.commit(token, () => peerDb.putRecords('sessions', [record]), { rebase: true });
    },
    async localSave() {
      h.type('observer edit after refresh');
      assert.equal(await h.context.saveState({ requireDurable: true }), true);
      return network.messages.filter(e => e.sender.tab.id === 1 && e.message.method === 'put').at(-1);
    },
    close() { h.context.sharedSessionViewSync.dispose(); network.close(); }
  };
}


module.exports = { refreshLab, session, remoteRun, State, RawDb };
