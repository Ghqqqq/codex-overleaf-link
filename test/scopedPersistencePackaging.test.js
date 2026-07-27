const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('queue persistence policy loads before the transaction in direct and managed runtimes', () => {
  const extensionManifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'extension', 'manifest.json'),
    'utf8',
  ));
  const runtimeManifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'extension', 'runtime-manifest.json'),
    'utf8',
  ));
  const scriptLists = [
    extensionManifest.content_scripts[0].js,
    runtimeManifest.js
  ];

  for (const scripts of scriptLists) {
    const policyIndex = scripts.indexOf('src/shared/scopedPersistenceQueuePolicy.js');
    const adapterIndex = scripts.indexOf('src/shared/scopedPersistenceBrowserAdapter.js');
    const transactionIndex = scripts.indexOf('src/shared/scopedPersistenceTransaction.js');
    const coordinatorIndex = scripts.indexOf('src/content/scopedPersistenceCoordinator.js');
    assert.ok(policyIndex >= 0, 'queue policy should be packaged');
    assert.ok(adapterIndex > policyIndex, 'browser adapter should load after queue policy');
    assert.ok(transactionIndex > adapterIndex, 'transaction should load after browser adapter');
    assert.ok(coordinatorIndex > transactionIndex, 'content adapter should load after transaction');
  }
});
