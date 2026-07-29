const assert = require('node:assert/strict');
const test = require('node:test');

const PanelState = require('../extension/src/content/scopedPersistencePanelState');

function createHarness() {
  let builtInput = null;
  let writeOptions = null;
  const StorageDb = {
    extractLightweightPrefs() {
      return {};
    },
    buildActiveSessionByProject(_existing, projectId, activeSessionId) {
      return { [projectId]: activeSessionId };
    },
    buildSessionRecord(input) {
      builtInput = structuredClone(input);
      return structuredClone(input);
    }
  };
  const Migration = {
    async loadPrefs() {
      return {};
    },
    async savePrefs() {}
  };
  const SessionPersistence = {
    async writeSessions(options) {
      writeOptions = {
        accountScopeId: options.accountScopeId,
        projectId: options.projectId,
        writerId: options.writerId,
        sessionRecords: structuredClone(options.sessionRecords)
      };
    }
  };
  return {
    StorageDb,
    Migration,
    SessionPersistence,
    get builtInput() {
      return builtInput;
    },
    get writeOptions() {
      return writeOptions;
    }
  };
}

test('panel persistence writes the account scope captured by the transaction', async () => {
  const harness = createHarness();
  await PanelState.persistPanelState({
    state: {
      activeSessionId: 'session-a',
      sessions: [{ id: 'session-a', title: 'A', pendingInputs: [] }],
      experimentalOtByProject: {},
      governanceRulesByProject: {},
      customInstructionsByProject: {}
    },
    compactState: { activeSessionId: 'session-a' },
    projectId: 'project-a',
    Migration: harness.Migration,
    StorageDb: harness.StorageDb,
    SessionPersistence: harness.SessionPersistence,
    normalizeExperimentalOtByProject: value => value,
    normalizeGovernanceRulesByProject: value => value,
    normalizeCustomInstructionsByProject: value => value,
    persistenceContext: {
      scope: { accountScopeId: 'account-a', projectId: 'project-a' },
      nextMeta: {},
      writerId: 'writer-a'
    }
  });

  assert.equal(harness.builtInput.accountScopeId, 'account-a');
  assert.equal(harness.writeOptions.accountScopeId, 'account-a');
});

test('panel persistence fails closed when the captured scope is absent or stale', async () => {
  const harness = createHarness();
  const base = {
    state: {
      sessions: [],
      experimentalOtByProject: {},
      governanceRulesByProject: {},
      customInstructionsByProject: {}
    },
    compactState: {},
    projectId: 'project-a',
    Migration: harness.Migration,
    StorageDb: harness.StorageDb,
    SessionPersistence: harness.SessionPersistence,
    normalizeExperimentalOtByProject: value => value,
    normalizeGovernanceRulesByProject: value => value,
    normalizeCustomInstructionsByProject: value => value
  };

  await assert.rejects(
    PanelState.persistPanelState(base),
    error => error?.code === 'account_scope_unavailable'
  );
  await assert.rejects(
    PanelState.persistPanelState({
      ...base,
      persistenceContext: {
        scope: { accountScopeId: 'account-a', projectId: 'project-b' }
      }
    }),
    error => error?.code === 'stale_view'
  );
});

test('panel persistence uses the immutable state captured before async preference loading', async () => {
  const harness = createHarness();
  let releasePrefs;
  let signalPrefs;
  const prefsStarted = new Promise(resolve => { signalPrefs = resolve; });
  harness.Migration.loadPrefs = async () => {
    signalPrefs();
    await new Promise(resolve => { releasePrefs = resolve; });
    return {};
  };
  const state = {
    activeSessionId: 'session-a',
    sessions: [{ id: 'session-a', title: 'original', pendingInputs: [] }],
    experimentalOtByProject: {},
    governanceRulesByProject: {},
    customInstructionsByProject: {}
  };
  const pending = PanelState.persistPanelState({
    state,
    compactState: structuredClone(state),
    projectId: 'project-a',
    Migration: harness.Migration,
    StorageDb: harness.StorageDb,
    SessionPersistence: harness.SessionPersistence,
    normalizeExperimentalOtByProject: value => value,
    normalizeGovernanceRulesByProject: value => value,
    normalizeCustomInstructionsByProject: value => value,
    persistenceContext: {
      scope: { accountScopeId: 'account-a', projectId: 'project-a' },
      nextMeta: {},
      writerId: 'writer-a'
    }
  });

  await prefsStarted;
  state.sessions[0].title = 'mutated-after-commit-started';
  releasePrefs();
  await pending;

  assert.equal(harness.builtInput.title, 'original');
});

test('panel persistence scopes preference reads and writes to the captured account', async () => {
  const harness = createHarness();
  const calls = [];
  harness.Migration.loadPrefs = async (...args) => {
    calls.push(['load', ...args]);
    return {};
  };
  harness.Migration.savePrefs = async (_prefs, ...args) => {
    calls.push(['save', ...args]);
  };

  await PanelState.persistPanelState({
    state: {
      activeSessionId: 'session-a',
      sessions: [{ id: 'session-a', title: 'A', pendingInputs: [] }],
      experimentalOtByProject: {},
      governanceRulesByProject: {},
      customInstructionsByProject: {}
    },
    compactState: { activeSessionId: 'session-a' },
    projectId: 'project-a',
    Migration: harness.Migration,
    StorageDb: harness.StorageDb,
    SessionPersistence: harness.SessionPersistence,
    normalizeExperimentalOtByProject: value => value,
    normalizeGovernanceRulesByProject: value => value,
    normalizeCustomInstructionsByProject: value => value,
    persistenceContext: {
      scope: { accountScopeId: 'account-a', projectId: 'project-a' },
      nextMeta: {},
      writerId: 'writer-a'
    }
  });

  assert.deepEqual(calls, [
    ['load', 'account-a', 'project-a'],
    ['save', 'account-a', 'project-a']
  ]);
});
