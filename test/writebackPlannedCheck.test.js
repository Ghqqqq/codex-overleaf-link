'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Controller = require('../extension/src/content/writebackController');
const Intent = require('../extension/src/shared/writebackIntent');
const digest = text => createHash('sha256').update(text).digest('hex');
const owner = { id: 'plan-a', projectId: 'p', accountScopeId: 'account-a', sessionId: 's', runId: 'r', createdAt: '2026-10-04T00:00:00.000Z' };
const project = { id: 'p', files: [{ path: 'main.tex', content: 'before' }, { path: 'empty.tex', content: '' }] };

test('planned hash check validates edits, empty content, creates, moves and binary postimages without retaining payload', async () => {
  const check = await Controller.buildPlannedWritebackCheck([
    { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 6, expected: 'before', insert: 'after' }] },
    { type: 'create', path: 'created.tex', content: '-----BEGIN SYNTHETIC PRIVATE KEY-----' },
    { type: 'move', path: 'empty.tex', to: 'moved.tex' },
    { type: 'binary-create', path: 'image.png', sha256: 'a'.repeat(64), assetRef: { token: 'must-not-persist' } }
  ], project, owner);
  assert.equal(check.purpose, 'writeback-revalidation');
  assert.deepEqual(check.files, [
    { path: 'main.tex', kind: 'text', sha256: digest('after') },
    { path: 'created.tex', kind: 'text', sha256: digest('-----BEGIN SYNTHETIC PRIVATE KEY-----') },
    { path: 'empty.tex', absent: true }, { path: 'moved.tex', kind: 'text', sha256: digest('') },
    { path: 'image.png', kind: 'binary', sha256: 'a'.repeat(64) }
  ]);
  assert.doesNotMatch(JSON.stringify(check), /SYNTHETIC PRIVATE|must-not-persist|contentBase64|patches|assetRef|appliedOperations/);
  assert.deepEqual(Intent.normalizeWritebackCheck(check), check);
});
for (const operation of [
  { type: 'edit', path: 'main.tex', patches: [{ from: 0, to: 6, expected: 'wrong', insert: 'after' }] },
  { type: 'edit', path: 'missing.tex', replaceAll: 'after' },
  { type: 'edit', path: 'main.tex', patches: [{ from: -1, to: 2, expected: 'be', insert: 'after' }] },
  { type: 'binary-create', path: 'image.png' }, { type: 'delete', path: '../secret' }
]) test('uncomputable planned state refuses a recovery guarantee: ' + operation.type + '/' + operation.path, async () => {
  await assert.rejects(Controller.buildPlannedWritebackCheck([operation], project, owner), error => error.code === 'writeback_plan_unavailable');
});
test('binary move proof predicts source absence and destination hash', async () => {
  const check = await Controller.buildPlannedWritebackCheck([{ type: 'move', path: 'old.png', to: 'new.png',
    moveProof: { v: 1, kind: 'binary', sha256: 'b'.repeat(64) } }], project, owner);
  assert.deepEqual(check.files, [{ path: 'old.png', absent: true }, { path: 'new.png', kind: 'binary', sha256: 'b'.repeat(64) }]);
});
test('normalizer rejects malformed owner, scope, budget and proofs while discarding content fields', () => {
  const good = { ...owner, v: 1, purpose: 'writeback-revalidation', files: [{ path: 'a.tex', kind: 'text', sha256: 'a'.repeat(64) }] };
  assert.equal(Intent.normalizeWritebackCheck({ ...good, accountScopeId: '' }), null);
  assert.equal(Intent.normalizeWritebackCheck({ ...good, id: 'x'.repeat(161) }), null);
  assert.equal(Intent.normalizeWritebackCheck({ ...good, purpose: 'executed' }), null);
  assert.equal(Intent.normalizeWritebackCheck({ ...good, files: [{ path: '../a', absent: true }] }), null);
  assert.equal(Intent.normalizeWritebackCheck({ ...good, files: Array(1001).fill(good.files[0]) }), null);
  assert.deepEqual(Intent.normalizeWritebackCheck({ ...good, content: 'secret', assetRef: 'token', checkedAt: owner.createdAt, observation: 'matches' }),
    { ...good, checkedAt: owner.createdAt, observation: 'matches' });
});

for (const [sourceEnding, editorEnding] of [['\r\n', '\n'], ['\n', '\r\n']]) {
  test(`planned read-only check follows real Page newline mapping ${JSON.stringify(sourceEnding)} to ${JSON.stringify(editorEnding)}`, async t => {
    const { harness, PROJECT } = require('./_helpers/binaryWritebackHarness');
    const before = ['alpha', 'beta', ''].join(sourceEnding), after = ['alpha', 'new', 'beta', ''].join(sourceEnding);
    const h = await harness(t, { baseText: before, editorText: before.replace(/\r\n?/g, '\n').replace(/\n/g, editorEnding) });
    const ops = Controller.buildSyncApplyOperations([{ type: 'write', path: 'main.tex', previousContent: before, content: after }], h.project);
    const check = await Controller.buildPlannedWritebackCheck(ops, h.project, { ...owner, projectId: PROJECT });
    const written = await h.dispatch('applyOperations', { writebackRequestId: 'newline-write', runProjectId: PROJECT, operations: ops, baseFiles: h.project.files });
    assert.equal(written.ok, true); assert.equal(written.applied.length, 1);
    assert.equal(h.textFiles.get('main.tex'), ['alpha', 'new', 'beta', ''].join(editorEnding));
    const result = await Controller.confirmSaveCheck(check, { assertCurrent() {}, readSnapshot: async () => ({
      id: PROJECT, capabilities: { fullProjectSnapshot: true, method: 'overleaf-zip' },
      files: [{ path: 'main.tex', content: h.textFiles.get('main.tex'), source: 'overleaf-zip' }]
    }) });
    assert.equal(result.ok, true);
    await h.cleanup();
  });
}

test('normal save confirmation retains binary move source absence and destination digest', async () => {
  const proof = { v: 1, kind: 'binary', sha256: 'b'.repeat(64) };
  const check = await Controller.buildSaveCheck({ applied: [{ operation: { type: 'move', path: 'old.png', to: 'new.png', moveProof: proof },
    result: { ok: true, moveProof: proof } }] }, { id: 'p', files: [{ path: 'old.png', kind: 'binary' }] }, owner);
  assert.deepEqual(check.files, [{ path: 'old.png', absent: true }, { path: 'new.png', sha256: 'b'.repeat(64), kind: 'binary' }]);
});
