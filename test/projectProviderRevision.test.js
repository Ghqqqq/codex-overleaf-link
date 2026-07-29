const assert = require('node:assert/strict');
const test = require('node:test');

function loadSelection() {
  const modulePath = require.resolve('../extension/src/content/projectProviderSelection.js');
  delete require.cache[modulePath];
  global.window = {};
  require(modulePath);
  return global.window.CodexOverleafProjectProviderSelection;
}

function createHarness({ revision = 1, nextRevision = revision } = {}) {
  let state = {
    providerId: 'dpsk',
    providerRevision: revision,
    model: 'deepseek-v4',
    reasoningEffort: 'high',
    speedTier: '',
    sessions: [{
      id: 'session-1',
      providerId: 'dpsk',
      model: 'deepseek-v4',
      codexThreadId: 'thread-from-old-provider-config'
    }]
  };
  const api = loadSelection().create({
    getState: () => state,
    setState: next => { state = next; },
    normalizeState: value => value,
    getRunSelection: () => ({ providerRevision: nextRevision }),
    readSelectedModel: () => state.model,
    readSelectedSpeed: () => state.speedTier,
    getPanel: () => null,
    applyStateToPanel: () => {}
  });
  return { api, getState: () => state };
}

test('same provider id with a new revision clears stale Codex thread bindings', () => {
  const harness = createHarness({ revision: 1, nextRevision: 2 });
  harness.api.commit('dpsk', 'deepseek-v4');

  const state = harness.getState();
  assert.equal(state.providerRevision, 2);
  assert.equal(state.sessions[0].codexThreadId, '');
});

test('unchanged provider revision preserves the current Codex thread binding', () => {
  const harness = createHarness({ revision: 2, nextRevision: 2 });
  harness.api.commit('dpsk', 'deepseek-v4');

  assert.equal(
    harness.getState().sessions[0].codexThreadId,
    'thread-from-old-provider-config'
  );
});
