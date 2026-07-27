const test = require('node:test');
const assert = require('node:assert/strict');

const Contract = require('../extension/src/shared/pageRpcContract.js');

test('page RPC catalog owns every public page bridge method', () => {
  assert.deepEqual(Contract.listMethods(), [
    'initializeCapability', 'probe', 'cancelActiveWrite', 'getProjectSnapshot',
    'getProjectFileList', 'invalidateProjectSnapshot', 'createCheckpoint',
    'ensureReviewing', 'ensureEditing', 'applyOperations', 'jumpToPosition',
    'rejectTrackedChanges', 'acceptTrackedChanges', 'triggerCompile',
    'getCompileLog', 'getCompileState', 'waitForSaveState', 'startOtObserver',
    'stopOtObserver', 'getOtStatus', 'drainOtEvents'
  ]);
});

test('page RPC timeout and cancellation policy preserves existing behavior', () => {
  assert.equal(Contract.resolveTimeoutMs('getProjectSnapshot'), 70000);
  assert.equal(Contract.resolveTimeoutMs('getProjectFileList'), 35000);
  assert.equal(Contract.resolveTimeoutMs('triggerCompile'), 75000);
  assert.equal(Contract.resolveTimeoutMs('acceptTrackedChanges'), 120000);
  assert.equal(Contract.resolveTimeoutMs('applyOperations'), 30000);
  assert.equal(Contract.resolveTimeoutMs('probe'), 8000);
  assert.equal(Contract.isCancellable('applyOperations'), true);
  assert.equal(Contract.isCancellable('triggerCompile'), false);
  assert.deepEqual(Contract.resolveDispatchPolicy('applyOperations', { writeback: 30000 }), {
    timeoutMs: 30000,
    cancellation: 'content_abort',
    retryClass: 'no_retry',
    automaticAttempts: 1
  });
});

test('document mutations declare project identity and non-retry semantics', () => {
  for (const method of ['applyOperations', 'acceptTrackedChanges', 'rejectTrackedChanges']) {
    const entry = Contract.getMethod(method);
    assert.equal(entry.mutation, 'document', method);
    assert.equal(entry.projectIdentity, 'required', method);
    assert.equal(entry.retryClass, 'no_retry', method);
  }
});

test('navigation and compile side effects require explicit project identity', () => {
  for (const method of ['jumpToPosition', 'triggerCompile', 'getCompileLog']) {
    const entry = Contract.getMethod(method);
    assert.equal(entry.projectIdentity, 'required', method);
    assert.equal(Contract.requiresProjectIdentity(method), true, method);
  }
});

test('snapshot reads remain cancellable without entering the write identity guard', () => {
  for (const method of ['getProjectSnapshot', 'getProjectFileList']) {
    const entry = Contract.getMethod(method);
    assert.equal(entry.mutation, 'read', method);
    assert.equal(entry.projectIdentity, 'none', method);
    assert.equal(Contract.requiresProjectIdentity(method), false, method);
    assert.equal(entry.cancellation, 'content_abort', method);
  }
});

test('capability report and failure normalization are derived from the catalog', () => {
  const report = Contract.capabilityReport();
  assert.equal(report.applyOperations.capability, 'document.write');
  assert.equal(report.getProjectSnapshot.timeoutClass, 'snapshot');
  assert.deepEqual(Contract.normalizeFailure('applyOperations', new Error('boom')), {
    ok: false,
    code: 'page_bridge_dispatch_failed',
    error: 'boom',
    rpcMethod: 'applyOperations',
    failureClass: 'write'
  });
});
