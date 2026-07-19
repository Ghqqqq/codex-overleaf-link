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
