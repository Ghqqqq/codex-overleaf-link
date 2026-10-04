'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./_helpers/extractFunction');
const SessionState = require('../extension/src/shared/sessionState');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
function setup(options = {}) {
  const io = { commits: 0, fallback: 0, notices: [], end: 0 };
  const state = SessionState.normalizePanelState({});
  const context = vm.createContext({
    state, structuredClone, Modules: { StorageDb: {}, StorageMigration: {} },
    sharedSessionViewSync: { beginSave: () => () => { io.end++; } },
    currentRunView: options.diverged ? { runProjectId: 'another-project' } : null,
    getCurrentProjectId: () => options.noProject ? '' : 'project',
    prepareStateForStorage: SessionState.prepareStateForStorage,
    getCodexOverleafSkillEnabled: () => ({}), notifyAggressiveCompactionOnce() {},
    normalizeExperimentalOtByProject: x => x, normalizeGovernanceRulesByProject: x => x,
    normalizeCustomInstructionsByProject: x => x,
    getScopedPersistenceCoordinator: () => ({ async commit() {
      io.commits++;
      if (options.error) throw Object.assign(new Error(options.error), { code: options.error });
      return options.stale ? { ok: false, reason: 'stale_view' } : { ok: true };
    } }),
    getComposerDraftPersistence: () => ({ async save() {} }),
    cachedAccountScopeId: 'account', storageKey: 'project-storage',
    buildScopedFallbackStorageKey: () => 'scoped-fallback',
    prepareCompactFallbackState: () => ({ sessions: [], task: '' }),
    chrome: { storage: { local: { async set() { io.fallback++; } } } },
    tx: en => en, appendPlainLog() {}, isStorageQuotaError: () => false,
    appendStorageNoticeOnce: (_id, text) => io.notices.push(text)
  });
  for (const name of ['readLiveRunViewForSaveStateGuard', 'saveState']) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return { io, save: context.saveState };
}
test('strict persistence returns confirmation only after successful commit', async () => {
  const h = setup(); assert.equal(await h.save({ requireDurable: true }), true);
  assert.equal(h.io.commits, 1); assert.equal(h.io.end, 1); assert.equal(h.io.fallback, 0);
});
for (const options of [{ noProject: true }, { diverged: true }, { stale: true },
  { error: 'account_scope_unavailable' }, { error: 'recovery_scope_changed' }, { error: 'shared_session_deleted' }, { error: 'write_failed' }]) {
  test('strict persistence rejects incomplete save: ' + JSON.stringify(options), async () => {
    const h = setup(options); await assert.rejects(h.save({ requireDurable: true }));
    assert.equal(h.io.fallback, 0, 'fallback is not evidence that the cleared session was saved');
    assert.equal(h.io.end, 1);
  });
}
test('ordinary autosave retains its existing fallback and warning behavior', async () => {
  const h = setup({ error: 'write_failed' }); await h.save();
  assert.equal(h.io.commits, 1); assert.equal(h.io.fallback, 1); assert.equal(h.io.notices.length, 1);
});
test('ordinary stale-view autosave remains a no-op', async () => {
  const h = setup({ stale: true }); await h.save();
  assert.equal(h.io.fallback, 0); assert.equal(h.io.notices.length, 0);
});
