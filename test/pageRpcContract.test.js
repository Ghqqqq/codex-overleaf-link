const test = require('node:test');
const assert = require('node:assert/strict');

const Contract = require('../extension/src/shared/pageRpcContract.js');

test('page RPC catalog owns every public page bridge method', () => {
  assert.deepEqual(Contract.listMethods(), [
    'initializeCapability', 'probe', 'cancelActiveWrite', 'getProjectSnapshot',
    'getProjectFileList', 'listReferenceProjects', 'getReferenceProjectSnapshot', 'cancelReferenceRead',
    'invalidateProjectSnapshot', 'createCheckpoint',
    'ensureReviewing', 'ensureEditing', 'applyOperations', 'getWritebackReceipt', 'getSelectionContext',
    'binaryUploadBegin', 'binaryUploadAppend', 'binaryUploadCommit', 'binaryUploadStatus', 'binaryUploadAbort',
    'jumpToPosition', 'reconcileTrackedChangeCapture',
    'rejectTrackedChanges', 'acceptTrackedChanges', 'triggerCompile',
    'getCompileLog', 'getCompileState', 'waitForSaveState', 'startOtObserver',
    'stopOtObserver', 'getOtStatus', 'drainOtEvents'
  ]);
});

test('page RPC catalog owns timeout and cancellation policy', () => {
  assert.equal(Contract.resolveTimeoutMs('getProjectSnapshot'), 70000);
  assert.equal(Contract.resolveTimeoutMs('getProjectFileList'), 35000);
  assert.equal(Contract.resolveTimeoutMs('triggerCompile'), 75000);
  assert.equal(Contract.resolveTimeoutMs('acceptTrackedChanges'), 120000);
  assert.equal(Contract.resolveTimeoutMs('applyOperations'), 45000);
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
  for (const method of [
    'applyOperations', 'binaryUploadCommit',
    'acceptTrackedChanges', 'rejectTrackedChanges'
  ]) {
    const entry = Contract.getMethod(method);
    assert.equal(entry.mutation, 'document', method);
    assert.equal(entry.projectIdentity, 'required', method);
    assert.equal(entry.retryClass, 'no_retry', method);
  }
});

test('binary upload staging remains cache-scoped until commit', () => {
  for (const method of ['binaryUploadBegin', 'binaryUploadAppend', 'binaryUploadAbort']) {
    const entry = Contract.getMethod(method);
    assert.equal(entry.mutation, 'cache', method);
    assert.notEqual(entry.capability, 'asset.write', method);
  }
  assert.equal(Contract.getMethod('binaryUploadCommit').capability, 'asset.write');
  assert.equal(Contract.getMethod('binaryUploadCommit').mutation, 'document');
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

test('writeback receipt lookup is a project-scoped read and never retries a mutation', () => {
  const method = Contract.getMethod('getWritebackReceipt');
  assert.equal(method.mutation, 'read');
  assert.equal(method.projectIdentity, 'required');
  assert.equal(method.retryClass, 'safe');
  assert.equal(Contract.getMethod('applyOperations').retryClass, 'no_retry');
});

test('writing-style reference reads and their cancellation cannot mutate a document', () => {
  for (const name of ['listReferenceProjects', 'getReferenceProjectSnapshot']) {
    const entry = Contract.getMethod(name);
    assert.equal(entry.mutation, 'read');
    assert.equal(entry.retryClass, 'safe');
    assert.equal(entry.projectIdentity, 'none');
    assert.equal(entry.cancellation, 'none');
  }
  const cancel = Contract.getMethod('cancelReferenceRead');
  assert.equal(cancel.capability, 'reference.cancel');
  assert.equal(cancel.mutation, 'control');
  assert.equal(cancel.retryClass, 'idempotent');
});
test('selection and binary receipt reads stay bound to the explicit project', () => {
  for (const name of ['getSelectionContext', 'binaryUploadStatus']) {
    const entry = Contract.getMethod(name);
    assert.equal(entry.mutation, 'read');
    assert.equal(entry.projectIdentity, 'required');
    assert.equal(entry.retryClass, 'safe');
    assert.equal(Contract.resolveDispatchPolicy(name).automaticAttempts, 1);
  }
  assert.equal(Contract.getMethod('binaryUploadCommit').retryClass, 'no_retry');
});
