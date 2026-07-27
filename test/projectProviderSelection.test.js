const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../extension/src/content/projectProviderSelection.js'),
  'utf8'
);

function loadController(deps) {
  const context = { window: {} };
  vm.runInNewContext(SOURCE, context, { filename: 'projectProviderSelection.js' });
  return context.window.CodexOverleafProjectProviderSelection.create(deps);
}

test('provider switching updates future defaults without rewriting queued or historical execution', () => {
  const pendingInputs = [{
    id: 'queued-1',
    payload: {
      providerId: 'provider-a',
      providerRevision: '4',
      model: 'model-a',
      executionSnapshot: {
        providerId: 'provider-a',
        providerRevision: '4',
        model: 'model-a'
      }
    }
  }];
  const runs = [{
    id: 'run-1',
    providerId: 'provider-a',
    model: 'model-a',
    executionSnapshot: {
      providerId: 'provider-a',
      providerRevision: '4',
      model: 'model-a'
    }
  }];
  const state = {
    providerId: 'provider-a',
    model: 'model-a',
    reasoningEffort: 'high',
    speedTier: 'standard',
    sessions: [{
      id: 'session-1',
      providerId: 'provider-a',
      model: 'model-a',
      codexThreadId: 'thread-a',
      pendingInputs,
      runs
    }]
  };
  let nextState;
  const controller = loadController({
    getState: () => state,
    getRunSelection: () => ({ providerRevision: 9 }),
    readSelectedModel: () => 'model-b',
    readSelectedSpeed: () => 'fast',
    getPanel: () => ({ querySelector: () => ({ value: 'medium' }) }),
    normalizeState: value => value,
    setState: value => { nextState = value; },
    applyStateToPanel: () => {}
  });

  controller.commit('provider-b', 'model-b');

  assert.equal(nextState.providerId, 'provider-b');
  assert.equal(nextState.providerRevision, 9);
  assert.equal(nextState.sessions[0].providerId, 'provider-b');
  assert.equal(nextState.sessions[0].codexThreadId, '');
  assert.deepEqual(nextState.sessions[0].pendingInputs, pendingInputs);
  assert.deepEqual(nextState.sessions[0].runs, runs);
});
