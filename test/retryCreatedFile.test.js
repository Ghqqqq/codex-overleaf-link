'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHarness } = require('./_helpers/retryCreateHarness');

// Runtime Retry, recovery staging/settlement, orchestrator, broker, journal,
// Page wrapper, router, creator and Undo recording are production code.
// DOM, server ZIP, Native mirror and persistence I/O are synthetic.
for (const content of ['% already uploaded\n', '']) {
  test('Retry sync recognizes an existing exact file without uploading or acquiring Undo ownership: ' + JSON.stringify(content), async () => {
    const h = createHarness({ existing: content, content });
    const result = await h.retry();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.applied[0].result.idempotent, true);
    assert.equal(result.applied[0].result.changedDocument, false);
    assert.equal(h.f.clicks.length, 0);
    assert.equal(h.f.files.get(h.op.path), content);
    assert.equal(h.record.retryWriteback, undefined);
    assert.equal(h.record.status, 'completed');
    assert.deepEqual(Array.from(h.record.undoOperations || []), []);
    assert.deepEqual(Array.from(h.record.appliedOperations || []), []);
    const dispatches = h.trace.filter(entry => entry.layer === 'pageRpc').length;
    await h.retry();
    assert.equal(h.trace.filter(entry => entry.layer === 'pageRpc').length, dispatches, 'settled recovery cannot dispatch again');
  });
}

test('Retry sync settles an actual unconfirmed creation once ZIP reading recovers', async () => {
  const h = createHarness({ pending: false, zipOptions: { zipFailsAfterUpload: true } });
  const first = await h.initialCreate();
  assert.equal(first.applied.length, 0);
  assert.equal(first.skipped[0].result.code, 'file_upload_unconfirmed');
  assert.equal(first.skipped[0].result.changedDocument, true);
  assert.equal(h.f.files.get(h.op.path), h.op.content);
  assert.ok(h.record.retryWriteback);
  h.fixtureOptions.zipFailsAfterUpload = false;
  const retry = await h.retry();
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.applied[0].result.idempotent, true);
  assert.equal(retry.applied[0].result.changedDocument, false);
  assert.deepEqual(Array.from(h.f.clicks), [h.op.path]);
  assert.equal(h.record.retryWriteback, undefined);
  assert.equal(h.record.status, 'completed');
  assert.deepEqual(Array.from(h.record.undoOperations || []), [], 'a readback cannot manufacture creation ownership');
  assert.deepEqual(Array.from(h.record.appliedOperations || []), []);
});

test('an idempotent Retry sync preserves unrelated existing Undo evidence', async () => {
  const content = '% already uploaded\n';
  const h = createHarness({ existing: content, content });
  const unrelated = [{ type: 'edit', path: 'main.tex', replaceAll: 'original' }];
  h.record.undoOperations = unrelated;
  h.record.appliedOperations = [{ type: 'edit', path: 'main.tex', replaceAll: 'changed' }];
  const before = JSON.stringify({ undo: h.record.undoOperations, applied: h.record.appliedOperations });
  assert.equal((await h.retry()).ok, true);
  assert.equal(JSON.stringify({ undo: h.record.undoOperations, applied: h.record.appliedOperations }), before);
});

test('Retry sync creates a still-missing file and records ordinary created-file Undo', async () => {
  const h = createHarness();
  const result = await h.retry();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.applied.length, 1);
  assert.notEqual(result.applied[0].result.idempotent, true);
  assert.equal(h.f.files.get(h.op.path), h.op.content);
  assert.deepEqual(Array.from(h.f.clicks), [h.op.path]);
  assert.equal(h.record.retryWriteback, undefined);
  assert.equal(h.record.status, 'completed');
  const undo = h.record.undoOperations.find(operation => operation.path === h.op.path);
  assert.equal(undo.type, 'delete');
  assert.ok(undo.undoCreatedFile);
});

test('ordinary creation still works and the same request receipt never uploads twice', async () => {
  const h = createHarness({ pending: false });
  const first = await h.initialCreate();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(h.record.retryWriteback, undefined);
  const executions = h.trace.length;
  const repeated = await h.duplicateOriginalRequest();
  assert.equal(repeated.applied.length, 1);
  assert.equal(repeated.skipped.length, 0);
  assert.equal(h.trace.length, executions, 'same request retrieves its receipt without reentering Router');
  assert.deepEqual(Array.from(h.f.clicks), [h.op.path]);
  assert.equal(h.record.undoOperations.length, 1);
});

test('Retry sync cannot overwrite an existing file with different content', async () => {
  const existing = '% later user content\n';
  const h = createHarness({ existing });
  const result = await h.retry();
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].result.code, 'target_file_already_exists');
  assert.equal(h.f.files.get(h.op.path), existing);
  assert.equal(h.f.clicks.length, 0);
  assert.ok(h.record.retryWriteback);
  assert.equal(h.record.status, 'failed');
  assert.deepEqual(Array.from(h.record.undoOperations || []), []);
});

test('ordinary create does not adopt an existing same-content file without explicit Retry', async () => {
  const content = '% ordinary same content\n';
  const h = createHarness({ existing: content, content, pending: false });
  const result = await h.initialCreate();
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].result.code, 'target_file_already_exists');
  assert.equal(h.f.clicks.length, 0);
});

test('Retry sync with a mismatched project owner never reaches the page', async () => {
  const h = createHarness();
  h.record.retryWriteback.projectId = 'other-project';
  assert.equal(await h.retry(), undefined);
  assert.equal(h.trace.length, 0);
  assert.equal(h.f.clicks.length, 0);
  assert.equal(h.f.files.has(h.op.path), false);
});
