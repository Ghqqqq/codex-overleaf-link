const assert = require('node:assert/strict');
const test = require('node:test');

const UpdateHealth = require('../extension/bootstrap/updateHealth');

test('closed tabs are removed from a pending runtime health check', () => {
  const pending = new Set([11, 12, 13]);
  UpdateHealth.pruneClosedTabIds(pending, [{ id: 11 }, { id: 13 }]);
  assert.deepEqual([...pending], [11, 13]);
});

test('a discarded tab remains a live health target while it still exists', () => {
  const pending = new Set([21]);
  UpdateHealth.pruneClosedTabIds(pending, [{ id: 21, discarded: true }]);
  assert.deepEqual([...pending], [21]);
});
