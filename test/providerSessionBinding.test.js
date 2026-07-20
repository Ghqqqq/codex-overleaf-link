'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ProviderProfiles = require('../extension/src/shared/providerProfiles');
const SessionState = require('../extension/src/shared/sessionState');

function customProvider(id, revision, modelId) {
  return {
    id,
    kind: 'custom',
    name: id,
    revision,
    baseUrl: `https://${id}.example/v1`,
    models: [{ id: modelId, label: modelId }],
    defaultModelId: modelId
  };
}

test('provider run selection can target a session provider independently of the global default', () => {
  const catalog = ProviderProfiles.normalizeCatalog({
    activeProviderId: 'provider-a',
    providers: [customProvider('provider-a', 4, 'model-a')]
  });

  assert.deepEqual(ProviderProfiles.buildRunSelection(catalog, 'builtin'), {
    providerId: 'builtin',
    providerRevision: 0
  });
  assert.deepEqual(ProviderProfiles.buildRunSelection(catalog, 'provider-a'), {
    providerId: 'provider-a',
    providerRevision: 4
  });
  assert.deepEqual(ProviderProfiles.buildRunSelection(catalog, 'deleted-provider'), {
    providerId: 'deleted-provider',
    providerRevision: 0
  });
});

test('switching sessions restores provider, model, reasoning, and speed as one configuration tuple', () => {
  const builtin = SessionState.createSession({
    task: 'Built-in session task',
    providerId: 'builtin',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    speedTier: 'fast'
  });
  const custom = SessionState.createSession({
    task: 'Custom provider session task',
    providerId: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'none',
    speedTier: 'standard'
  });
  let state = SessionState.normalizePanelState({
    sessions: [builtin, custom],
    activeSessionId: custom.id
  });

  assert.equal(state.providerId, 'provider-a');
  assert.equal(state.model, 'model-a');
  assert.equal(state.reasoningEffort, 'none');
  state = SessionState.setActiveSession(state, builtin.id);
  assert.equal(state.providerId, 'builtin');
  assert.equal(state.model, 'gpt-5.4');
  assert.equal(state.reasoningEffort, 'high');
  assert.equal(state.speedTier, 'fast');
});

test('legacy sessions without provider identity migrate conservatively to Built-in Codex', () => {
  const state = SessionState.normalizePanelState({
    providerId: 'provider-a',
    sessions: [{
      id: 'legacy-session',
      model: 'gpt-5.4',
      mode: 'ask',
      reasoningEffort: 'high',
      speedTier: 'standard'
    }],
    activeSessionId: 'legacy-session'
  });

  assert.equal(state.providerId, 'builtin');
  assert.equal(state.sessions[0].providerId, 'builtin');
});

test('storage compaction preserves the session provider and model tuple', () => {
  const session = SessionState.createSession({
    providerId: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'none',
    speedTier: 'standard'
  });
  const live = SessionState.normalizePanelState({
    sessions: [session],
    activeSessionId: session.id
  });

  const compact = SessionState.prepareStateForStorage(live);
  const restored = SessionState.normalizePanelState(compact);

  assert.equal(compact.sessions[0].providerId, 'provider-a');
  assert.equal(restored.providerId, 'provider-a');
  assert.equal(restored.model, 'model-a');
});

test('explicit Built-in activation clears a custom model before catalog refresh', async t => {
  const previousWindow = global.window;
  const coordinatorPath = require.resolve('../extension/src/content/providerSettingsCoordinator');
  class FakeBroadcastChannel {
    addEventListener() {}
    postMessage() {}
    close() {}
  }
  const fakeWindow = {
    BroadcastChannel: FakeBroadcastChannel,
    CodexOverleafProviderProfiles: ProviderProfiles,
    CodexOverleafProviderSettingsDialog: {
      create: () => ({ isOpen: () => false, destroy() {} })
    }
  };
  global.window = fakeWindow;
  delete require.cache[coordinatorPath];
  require(coordinatorPath);
  t.after(() => {
    delete require.cache[coordinatorPath];
    global.window = previousWindow;
  });

  let selectedProviderId = 'provider-a';
  let selectedModel = 'model-a';
  const calls = [];
  const coordinator = fakeWindow.CodexOverleafProviderSettingsCoordinator.create({
    document: {},
    window: fakeWindow,
    getSelectedProviderId: () => selectedProviderId,
    setSelectedProviderId: (providerId, modelId) => {
      selectedProviderId = providerId;
      selectedModel = modelId;
      calls.push(`provider:${providerId}`);
      calls.push(`model:${modelId}`);
    },
    refreshModelOptions: async selection => calls.push(`refresh:${selection.providerId}`),
    persistInputs: async () => calls.push('persist')
  });
  const catalog = ProviderProfiles.normalizeCatalog({
    activeProviderId: 'builtin',
    providers: [customProvider('provider-a', 4, 'model-a')]
  });
  coordinator._instance.catalog = catalog;
  coordinator._instance.loaded = true;

  await coordinator._instance.onProviderChanged(catalog, { sessionProviderId: 'builtin' });

  assert.equal(selectedProviderId, 'builtin');
  assert.equal(selectedModel, '');
  assert.deepEqual(calls, ['provider:builtin', 'model:', 'refresh:builtin', 'persist']);
});
