const test = require('node:test');
const assert = require('node:assert/strict');

const Coordinator = require('../extension/src/content/scopedPersistenceCoordinator.js');

test('persistPanelState merges project preferences and writes displayable sessions', async () => {
  let savedPrefs = null;
  let writeInput = null;
  const Migration = {
    async loadPrefs() {
      return {
        activeSessionByProject: { other: 'old' },
        experimentalOtByProject: { other: true },
        governanceRulesByProject: { other: { readonlyPatterns: [] } },
        customInstructionsByProject: { other: 'keep' }
      };
    },
    async savePrefs(value) {
      savedPrefs = value;
    }
  };
  const StorageDb = {
    extractLightweightPrefs() {
      return { model: 'gpt-test' };
    },
    buildActiveSessionByProject(previous, projectId, sessionId) {
      return { ...previous, [projectId]: sessionId };
    },
    buildSessionRecord(value) {
      return value;
    }
  };

  await Coordinator.persistPanelState({
    state: {
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1', title: 'Paper', focusFiles: [] }],
      experimentalOtByProject: { paper: true },
      governanceRulesByProject: { paper: { readonlyPatterns: ['out/**'] } },
      customInstructionsByProject: { paper: 'focus' }
    },
    compactState: { activeSessionId: 'session-1' },
    projectId: 'paper',
    persistenceContext: {
      scope: {
        accountScopeId: 'account-a',
        projectId: 'paper'
      }
    },
    Migration,
    StorageDb,
    SessionPersistence: {
      async writeSessions(value) {
        writeInput = value;
      }
    },
    normalizeExperimentalOtByProject: value => value,
    normalizeGovernanceRulesByProject: value => value,
    normalizeCustomInstructionsByProject: value => value
  });

  assert.equal(savedPrefs.model, 'gpt-test');
  assert.equal(savedPrefs.activeSessionByProject.other, 'old');
  assert.equal(savedPrefs.activeSessionByProject.paper, 'session-1');
  assert.equal(savedPrefs.customInstructionsByProject.other, 'keep');
  assert.equal(savedPrefs.customInstructionsByProject.paper, 'focus');
  assert.equal(writeInput.projectId, 'paper');
  assert.equal(writeInput.accountScopeId, 'account-a');
  assert.equal(writeInput.sessionRecords[0].id, 'session-1');
  assert.equal(writeInput.sessionRecords[0].accountScopeId, 'account-a');
});
