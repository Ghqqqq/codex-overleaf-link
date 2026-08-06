const assert = require('node:assert/strict');
const test = require('node:test');

const StorageRunActions = require('../extension/src/shared/storageRunActions');

test('preserves Reviewing native-editor undo payload when DOM refs are temporarily unavailable', () => {
  const run = {
    id: 'run-reviewing-native-undo',
    executionSnapshot: { requireReviewing: true },
    appliedOperations: [{ type: 'edit', path: 'main.tex' }],
    undoOperations: [],
    undoBaseFiles: [],
    undoTrackedChanges: [],
    undoExpectedFiles: [{ path: 'main.tex', content: 'after' }],
    undoStatus: ''
  };
  const compacted = StorageRunActions.compactRunsForStorage(
    [run],
    { preserveRunActionPayload: true },
    10,
    (value, keepActionPayload) => ({
      id: value.id,
      ...StorageRunActions.compactRunActionPayload(value, keepActionPayload)
    })
  );

  assert.equal(compacted[0].appliedOperations.length, 1);
  assert.equal(compacted[0].undoExpectedFiles.length, 1);
  assert.deepEqual(compacted[0].undoTrackedChanges, []);
});
