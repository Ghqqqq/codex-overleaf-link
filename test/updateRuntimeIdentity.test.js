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

test('only a verified rollback to the transaction source offers a downgrade reload', () => {
  const restoredPair = { extensionVersion: '2.5.1', nativeVersion: '2.5.1',
    extensionSha256: 'a'.repeat(64), nativeSha256: 'b'.repeat(64), bootstrapSha256: 'c'.repeat(64) };
  const transaction = { id: 'restore-one', sourceVersion: '2.5.1', targetVersion: '2.5.5', state: 'rolled_back', bootstrapRevision: '3.1' };
  const value = status({ activeVersion: '2.5.1', runtimeVersion: '2.5.5', transaction, restoredPair });
  const options = { extensionVersion: '2.5.5', runtimeVersion: '2.5.5' };
  assert.equal(inspectInstalledRuntime(value, options).state, 'reload_required');
  for (const invalid of [
    { restoredPair: null }, { restoredPair: { ...restoredPair, nativeSha256: '' } },
    { restoredPair: { ...restoredPair, bootstrapSha256: '' } },
    { restoredPair: { ...restoredPair, nativeVersion: '2.5.0' } },
    { transaction: { ...transaction, targetVersion: '2.5.4' } },
    { transaction: { ...transaction, sourceVersion: '2.5.0' } },
    { runtimeVersion: '2.5.6' }
  ]) assert.equal(inspectInstalledRuntime({ ...value, ...invalid }, options).state, 'repair_required');
});
