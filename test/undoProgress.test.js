'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { advanceUndoCheckpoint } = require('../extension/src/shared/undoOperations');
const proof = { v: 1, kind: 'binary', sha256: 'a'.repeat(64) };
const operation = { type: 'delete', path: 'new.png', undoCreatedFile: proof };
function run() {
  return { appliedOperations: [{ type: 'edit', path: 'main.tex' }, { type: 'binary-create', path: 'new.png' }],
    undoOperations: [operation], undoBaseFiles: [{ path: 'unrelated.tex', content: 'keep' }],
    undoExpectedFiles: [{ path: 'main.tex', content: 'before' }],
    undoTrackedChanges: [{ path: 'main.tex', id: 'owned' }],
    trackedChangeCaptures: [{ path: 'main.tex', state: 'pending' }, { path: 'other.tex', state: 'pending' }] };
}
function receipt(overrides = {}) {
  return { operation, result: { ok: true, verified: true, verification: 'overleaf-zip', ...overrides } };
}
test('verified receipts consume only finished recovery entries and preserve forward audit data', () => {
  const before = run(), snapshot = JSON.stringify(before);
  const next = advanceUndoCheckpoint(before, { applied: [receipt()], skipped: [] }, () => true);
  assert.deepEqual(next.undoOperations, []);
  assert.deepEqual(next.undoExpectedFiles, []);
  assert.deepEqual(next.undoTrackedChanges, []);
  assert.deepEqual(next.trackedChangeCaptures, [{ path: 'other.tex', state: 'pending' }]);
  assert.deepEqual(next.undoBaseFiles, [{ path: 'unrelated.tex', content: 'keep' }]);
  assert.equal(next.appliedOperations, before.appliedOperations);
  assert.equal(JSON.stringify(before), snapshot);
});
for (const override of [{ verified: false }, { ok: false }, { verification: 'dom' }]) {
  test('an unverified deletion receipt preserves its checkpoint: ' + JSON.stringify(override), () => {
    const before = run(); const next = advanceUndoCheckpoint(before, { applied: [receipt(override)] });
    assert.equal(next, before);
  });
}
test('a receipt with different created-file proof cannot consume recovery', () => {
  const before = run(), entry = receipt();
  entry.operation = { ...operation, undoCreatedFile: { ...proof, sha256: 'b'.repeat(64) } };
  assert.equal(advanceUndoCheckpoint(before, { applied: [entry] }), before);
});
test('an unscoped failure cannot discard verified-looking recovery evidence', () => {
  const before = run();
  assert.equal(advanceUndoCheckpoint(before, { applied: [receipt()], skipped: [{ result: { ok: false } }] }, () => true), before);
});
test('failure on one path preserves it while consuming the independent text receipt', () => {
  const before = run();
  const next = advanceUndoCheckpoint(before, { applied: [], skipped: [{ operation, result: { ok: false } }] }, () => true);
  assert.equal(next.undoOperations.length, 1);
  assert.equal(next.undoTrackedChanges.length, 0);
  assert.equal(next.undoExpectedFiles.length, 0);
});
test('pure text legacy checkpoints retain their existing settlement ownership', () => {
  const before = { ...run(), undoOperations: [{ type: 'edit', path: 'main.tex' }] };
  assert.equal(advanceUndoCheckpoint(before, { applied: [] }, () => true), before);
});
test('exactly verified absence is idempotent completion for a created file', () => {
  const next = advanceUndoCheckpoint(run(), { applied: [receipt({ idempotent: true, changedDocument: false })] });
  assert.equal(next.undoOperations.length, 0);
  assert.equal(next.undoExpectedFiles.length, 1, 'missing text evidence never consumes text recovery');
});
