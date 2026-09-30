'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Router = require('../extension/src/page/writebackRouter');
const StaleGuard = require('../extension/src/shared/staleGuard');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ beforeBatch, write } = {}) {
  let sequence = 0;
  const files = new Map(), calls = [], receipts = [];
  const router = Router.create({
    window: { CodexOverleafStaleGuard: StaleGuard },
    treeOperations: { getProjectId: () => 'example' },
    readWriteCancellationSequence: () => sequence,
    async beginTextCreateBatch(operations, options) {
      await beforeBatch?.(options);
      return { targets: new Set(operations.map(op => op.path)), pending: new Map(), blocked: new Set() };
    },
    async createTextFile(operation, options) {
      assert.equal(options.isCurrent(), true, 'a mutation must still own its project and cancellation sequence');
      calls.push(operation.path);
      files.set(operation.path, operation.content);
      if (write) return write(operation, options);
      return { ok: true, changedDocument: true, verified: true, verification: 'overleaf-zip' };
    }
  });
  return {
    files, calls, receipts,
    cancel() { sequence += 1; },
    apply(operations) {
      return router.applyOperations(operations, { runProjectId: 'example', baseFiles: [],
        onOperationResult: entry => receipts.push(entry) });
    }
  };
}

const operations = ['first.tex', 'second.tex', 'third.tex'].map(path => ({ type: 'create', path, content: path }));

test('writeback starts normally with the current cancellation sequence', async () => {
  const h = harness();
  h.cancel();
  h.cancel();
  const result = await h.apply(operations);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 3);
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(h.calls, operations.map(op => op.path));
});

test('cancellation during preflight prevents every mutation and the next request still runs', async () => {
  const entered = deferred(), release = deferred();
  const h = harness({ beforeBatch: async () => { entered.resolve(); await release.promise; } });
  const pending = h.apply(operations);
  try {
    await Promise.race([entered.promise, pending]);
    assert.equal(h.calls.length, 0);
    h.cancel();
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 3);
  assert.ok(result.skipped.every(entry => entry.result.code === 'codex_cancelled'
    && entry.result.failure.changedDocument === false));
  assert.equal(h.files.size, 0);
  const next = await h.apply(operations);
  assert.equal(next.ok, true);
  assert.equal(next.applied.length, 3);
});

for (const ok of [true, false]) {
  test(`in-flight ${ok ? 'saved' : 'partially changed'} output keeps its actual evidence and cancellation stops the tail`, async () => {
    const entered = deferred(), release = deferred();
    const operationResult = ok
      ? { ok: true, changedDocument: true, verified: true, verification: 'overleaf-zip',
        saveReceipt: { source: 'overleaf-zip', path: 'first.tex', sha256: 'a'.repeat(64) } }
      : { ok: false, changedDocument: true, code: 'file_upload_unconfirmed',
        failure: { code: 'file_upload_unconfirmed', changedDocument: true, severity: 'warning', terminalState: 'needs_review' } };
    const h = harness({ write: async () => { entered.resolve(); await release.promise; return operationResult; } });
    const pending = h.apply(operations);
    try {
      await Promise.race([entered.promise, pending]);
      assert.deepEqual(h.calls, ['first.tex']);
      assert.equal(h.files.get('first.tex'), 'first.tex');
      h.cancel();
    } finally { release.resolve(); }
    const result = await pending;
    assert.equal(result.ok, false);
    const actual = ok ? result.applied[0] : result.skipped[0];
    assert.equal(actual.operation.path, 'first.tex');
    assert.equal(actual.result, operationResult, 'do not replace real writeback evidence with a generic cancel result');
    const tail = result.skipped.filter(entry => entry.operation.path !== 'first.tex');
    assert.deepEqual(tail.map(entry => entry.operation.path), ['second.tex', 'third.tex']);
    assert.ok(tail.every(entry => entry.result.code === 'codex_cancelled'
      && entry.result.failure.changedDocument === false));
    assert.deepEqual(h.calls, ['first.tex']);
    assert.equal(h.files.has('second.tex'), false);
    assert.equal(h.receipts.length, 1);
    assert.equal(h.receipts[0].result, operationResult);
  });
}
