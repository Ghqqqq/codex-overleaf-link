const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectInstalledRuntime } = require('../extension/src/shared/updateRuntimeIdentity');

function status(overrides = {}) {
  return { managed: true, activeVersion: '2.3.6', runtimeVersion: '2.3.5', installedAligned: true,
    transaction: null, authorization: null, ...overrides };
}

test('disk installation and loaded components remain distinct until restart', () => {
  const result = inspectInstalledRuntime(status(), { extensionVersion: '2.3.5', runtimeVersion: '2.3.5' });
  assert.equal(result.state, 'reload_required');
  assert.equal(result.installedVersion, '2.3.6');
  assert.equal(result.nativeVersion, '2.3.5');
});

test('aligned running components can retire obsolete failure UI', () => {
  const result = inspectInstalledRuntime(status({ runtimeVersion: '2.3.6' }),
    { extensionVersion: '2.3.6', runtimeVersion: '2.3.6' });
  assert.equal(result.state, 'aligned');
});

test('unknown evidence, partial installations and active transactions cannot offer a restart', () => {
  const options = { extensionVersion: '2.3.5', runtimeVersion: '2.3.5' };
  assert.equal(inspectInstalledRuntime(status({ runtimeVersion: undefined }), options).state, 'unknown');
  assert.equal(inspectInstalledRuntime(status({ installedAligned: false }), options).state, 'repair_required');
  assert.equal(inspectInstalledRuntime(status({ transaction: { state: 'staged' } }), options).state, 'transaction_active');
  assert.equal(inspectInstalledRuntime(status({ transaction: { state: 'bootstrap_pending' } }), options).state, 'transaction_active');
  assert.equal(inspectInstalledRuntime(status({ transaction: { state: 'bootstrap_rolling_back' } }), options).state, 'transaction_active');
  assert.equal(inspectInstalledRuntime(status({ transaction: { state: 'rolling_back' } }), options).state, 'transaction_active');
  assert.equal(inspectInstalledRuntime(status({ authorization: { state: 'authorized' } }), options).state, 'transaction_active');
});

test('a lower installed version does not become a misleading reload offer', () => {
  assert.equal(inspectInstalledRuntime(status({ activeVersion: '2.3.4' }), {
    extensionVersion: '2.3.5', runtimeVersion: '2.3.5'
  }).state, 'repair_required');
});
