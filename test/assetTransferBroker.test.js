const assert = require('node:assert/strict');
const test = require('node:test');

const AssetTransferBroker = require('../extension/src/content/assetTransferBroker');

test('preserves page-bridge tracked changes when merging text writeback batches', () => {
  const merged = AssetTransferBroker.mergeApplyResults([
    {
      ok: true,
      applied: [{ operation: { type: 'edit', path: 'main.tex' }, result: { ok: true } }],
      skipped: [],
      trackedChanges: [{ key: 'change-main', path: 'main.tex' }]
    },
    {
      ok: true,
      applied: [{ operation: { type: 'edit', path: 'example/test.tex' }, result: { ok: true } }],
      skipped: [],
      trackedChanges: [{ key: 'change-nested', path: 'example/test.tex' }]
    }
  ]);

  assert.equal(merged.ok, true);
  assert.equal(merged.applied.length, 2);
  assert.deepEqual(merged.trackedChanges, [
    { key: 'change-main', path: 'main.tex' },
    { key: 'change-nested', path: 'example/test.tex' }
  ]);
});
