const assert = require('node:assert/strict');
const test = require('node:test');
const StorageRunActions = require('../extension/src/shared/storageRunActions');

// A thesis-sized run: edit a ~120 KB file and create a ~100 KB chapter. Undo
// needs the post-image of both and the pre-image of the edited file.
function thesisRun(extra = {}) {
  const roadmap = 'r'.repeat(120 * 1024), chapter = 'c'.repeat(100 * 1024);
  return {
    id: 'run-1',
    appliedOperations: [
      { type: 'edit', path: 'roadmap.md', patches: [{ from: 0, to: 1, expected: 'r', insert: 'R' }], verifiedContent: 'R' + roadmap.slice(1) },
      { type: 'create', path: 'tex_v1/Chap_03.tex', content: chapter }
    ],
    undoOperations: [
      { type: 'edit', path: 'roadmap.md', patches: [{ from: 0, to: 1, expected: 'R', insert: 'r' }] },
      { type: 'delete', path: 'tex_v1/Chap_03.tex', undoCreatedFile: { v: 1, kind: 'text' } }
    ],
    undoBaseFiles: [{ path: 'roadmap.md', content: 'R' + roadmap.slice(1) }, { path: 'tex_v1/Chap_03.tex', content: chapter }],
    undoExpectedFiles: [{ path: 'roadmap.md', content: roadmap }],
    undoTrackedChanges: [],
    ...extra
  };
}

test('a thesis-sized undo payload survives storage compaction', () => {
  const run = thesisRun();
  assert.ok(JSON.stringify(run).length > 320 * 1024, 'fixture exceeds the old cap');
  const payload = StorageRunActions.compactRunActionPayload(run, true);
  assert.equal(payload.undoOperations.length, 2);
  assert.equal(payload.undoBaseFiles.length, 2);
  assert.equal(payload.undoExpectedFiles.length, 1);
  assert.equal(payload.appliedOperations.length, 2);
});

test('a tracked-change run keeps its Accept payload at the same size', () => {
  const run = thesisRun({
    trackedChangeStatus: 'pending',
    undoTrackedChanges: [{ path: 'roadmap.md', id: 'tc-1', key: 'k1' }]
  });
  const payload = StorageRunActions.compactRunActionPayload(run, true);
  assert.equal(payload.undoTrackedChanges.length, 1);
  assert.equal(payload.appliedOperations.length, 2);
});

test('payloads above the cap are still dropped whole, never truncated', () => {
  const huge = 'h'.repeat(1100 * 1024);
  const run = thesisRun({ undoBaseFiles: [{ path: 'roadmap.md', content: huge }, { path: 'tex_v1/Chap_03.tex', content: huge }] });
  const payload = StorageRunActions.compactRunActionPayload(run, true);
  assert.equal(payload.undoOperations.length, 0);
  assert.equal(payload.undoBaseFiles.length, 0);
});
