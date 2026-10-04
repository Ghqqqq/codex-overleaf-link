'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Session = require('../extension/src/shared/sessionState');
const { createHarness } = require('./_helpers/retryCreateHarness');

function retiredCheck(runId) {
  return { v: 1, id: 'retired-check', purpose: 'writeback-revalidation', projectId: 'example',
    accountScopeId: 'fixture-account', sessionId: 'fixture-session', runId,
    createdAt: '2026-10-04T00:00:00Z', files: [{ path: 'retry-probe.tex', kind: 'text', sha256: 'a'.repeat(64) }] };
}

test('existing create staging preserves its recoverable retry before the original write', async () => {
  const h = createHarness({ pending: false });
  const result = await h.initialCreate();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(h.persisted[0].retryWriteback.operations, [h.op]);
  assert.equal(h.persisted[0].retryWriteback.accountScopeId, 'fixture-account');
  assert.equal(h.persisted[0].retryWriteback.sessionId, 'fixture-session');
  assert.equal(h.record.retryWriteback, undefined);
  for (const run of [...h.persisted, h.readStoredRun()]) {
    assert.equal(run.writebackCheck, undefined);
    assert.equal(run.manualReviewProof, undefined);
  }
  assert.equal(h.record.undoOperations.length, 1);
});

test('edit-only staging keeps the existing retry policy without manufacturing a planned-check record', async () => {
  const h = createHarness({ pending: false });
  h.runtime.currentRunView = { recordId: h.record.id, sessionId: 'fixture-session', runProjectId: 'example' };
  await h.runtime.stageWritebackRecovery([{ type: 'edit', path: 'main.tex', replaceAll: 'after' }], h.runtime.currentRunView, true);
  assert.equal(h.record.retryRequireReviewing, true);
  assert.equal(h.record.retryWriteback, undefined);
  assert.equal(h.record.writebackCheck, undefined);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.trace.length, 0);
});

test('legacy planned-check fields alone cannot enter Retry sync or grant Undo after reload', async () => {
  const h = createHarness({ pending: false });
  h.record.writebackCheck = retiredCheck(h.record.id);
  h.record.manualReviewProof = { v: 1, id: 'retired-review', runProjectId: 'example', accountScopeId: 'fixture-account', files: [] };
  assert.equal(await h.retry(), undefined);
  assert.equal(h.trace.length, 0);
  assert.equal(h.f.clicks.length, 0);
  await h.runtime.flushQueuedSaveState();
  const restored = Session.normalizeRuns([h.readStoredRun()])[0];
  assert.equal(restored.writebackCheck, undefined);
  assert.equal(restored.manualReviewProof, undefined);
  assert.deepEqual(restored.undoOperations, []);
});

test('legacy planned-check data does not prevent the original create retry from settling', async () => {
  const h = createHarness();
  h.record.writebackCheck = retiredCheck(h.record.id);
  const result = await h.retry();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Array.from(h.f.clicks), [h.op.path]);
  assert.equal(h.record.retryWriteback, undefined);
  assert.equal(h.record.undoOperations.length, 1);
  assert.equal(h.readStoredRun().writebackCheck, undefined);
});

test('create staging with missing account identity cannot send a write', async () => {
  const h = createHarness({ pending: false });
  h.runtime.cachedAccountScopeId = '';
  await assert.rejects(h.initialCreate(), /project or account identity/);
  assert.equal(h.persisted.length, 0);
  assert.equal(h.f.files.has(h.op.path), false);
  assert.equal(h.f.clicks.length, 0);
});

for (const change of ['account', 'project', 'route', 'view']) {
  test('create staging rechecks ' + change + ' after persistence before Page dispatch', async () => {
    const h = createHarness({ pending: false });
    const flush = h.runtime.flushQueuedSaveState;
    h.runtime.flushQueuedSaveState = async () => {
      await flush();
      if (change === 'account') h.runtime.cachedAccountScopeId = 'another-account';
      if (change === 'project') h.runtime.getCurrentProjectId = () => 'another-project';
      if (change === 'route') h.runtime.spaRouteGeneration++;
      if (change === 'view') h.runtime.currentRunView = { ...h.runtime.currentRunView };
    };
    await assert.rejects(h.initialCreate());
    assert.equal(h.trace.filter(entry => entry.layer === 'pageRpc').length, 0);
    assert.equal(h.f.files.has(h.op.path), false);
    assert.equal(h.f.clicks.length, 0);
    assert.deepEqual(h.persisted[0].retryWriteback.operations, [h.op], 'the captured recovery remains available');
  });
}
