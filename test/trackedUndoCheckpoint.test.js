'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewFixture, plain } = require('./_helpers/nativeReviewHarness');
const { createPersistenceFixture } = require('./_helpers/undoPersistenceHarness');

for (const receiptFault of ['', 'unscoped failure', 'unverified main', 'persisted old partial']) {
test('Track Undo checkpoint through Controller, Page RPC and persistence: ' + (receiptFault || 'scoped failure and retry'), async t => {
  const files = ['main.tex', 'nested/part.tex'].map((path, index) => ({ path,
    before: `% baseline ${index}\n`, content: `% baseline ${index}\n% run marker\n`,
    changes: [{ id: `owned-${index}`, op: { p: 13, i: '% run marker\n' } }] }));
  const editorUndoPaths = ['main.tex'];
  const page = createReviewFixture(t, { files, editorUndoPaths });
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const content = await createPersistenceFixture({ track: true,
    files: files.map(file => ({ path: file.path, content: file.before })),
    operations: files.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })),
    createRouter: () => page.router });
  t.after(() => { content.close(); page.close(); });
  content.run.undoTrackedChanges = files.flatMap(file => {
    page.state.active = file.path;
    return page.capture.prepareTrackedChangeCapture(file.path).refs;
  });
  assert.equal(content.run.undoTrackedChanges.length, 2);
  page.state.active = 'main.tex';
  await content.context.flushQueuedSaveState({ requireDurable: true });
  if (receiptFault === 'persisted old partial') {
    page.docs.get('main.tex').content = files[0].before;
    page.docs.get('main.tex').changes = [];
    const loaded = await content.load();
    for (const key of Object.keys(content.run)) delete content.run[key];
    Object.assign(content.run, loaded.run);
  }
  const requests = [], responses = [];
  content.context.callPageBridge = async (method, params) => {
    requests.push({ method, params: plain(params) });
    const result = await page.rpc(method, params);
    // Inject incomplete transport evidence after the real Page execution.
    if (receiptFault === 'unscoped failure') {
      result.skipped[0].trackedChange = null;
      delete result.skipped[0].result.file;
    }
    if (receiptFault === 'unverified main') delete result.applied[0].result.verified;
    responses.push(plain(result)); return result;
  };
  await page.ready();
  await page.timer.settle(content.undo());

  const result = responses[0];
  if (receiptFault === 'persisted old partial') {
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped[0].result.code, 'native_review_scope_changed');
    assert.equal(result.skipped[0].trackedChange.path, 'main.tex');
    const loaded = await content.load();
    assert.deepEqual(loaded.run.undoExpectedFiles.map(file => file.path), files.map(file => file.path));
    assert.deepEqual(loaded.run.undoTrackedChanges.map(ref => ref.path), files.map(file => file.path));
    assert.equal(loaded.buttons.undo.disabled, false);
    assert.equal(page.docs.get('main.tex').content, files[0].before);
    assert.equal(page.docs.get('nested/part.tex').content, files[1].content);
    assert.equal(page.docs.get('nested/part.tex').changes.length, 1);
    assert.equal(page.state.editorUndos?.length || 0, 0);
    assert.equal(page.state.writes.length, 0);
    return;
  }
  assert.equal(result.applied.length, 1, JSON.stringify(result));
  assert.equal(result.applied[0].result.verifiedContent, files[0].before);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].result.code, 'tracked_change_not_found');
  assert.equal(page.docs.get('main.tex').content, files[0].before);
  assert.equal(page.docs.get('nested/part.tex').content, files[1].content);
  assert.notEqual(content.run.undoStatus, 'applied');
  assert.notEqual(content.run.trackedChangeStatus, 'rejected');
  const loaded = await content.load();
  if (receiptFault) {
    assert.deepEqual(loaded.run.undoExpectedFiles.map(file => file.path), files.map(file => file.path));
    assert.deepEqual(loaded.run.undoTrackedChanges.map(ref => ref.path), files.map(file => file.path));
    assert.equal(loaded.buttons.undo.disabled, false);
    return;
  }
  assert.deepEqual(loaded.run.undoExpectedFiles.map(file => file.path), ['nested/part.tex']);
  assert.deepEqual(loaded.run.undoTrackedChanges.map(ref => ref.path), ['nested/part.tex']);
  assert.equal(loaded.buttons.undo.disabled, false);
  assert.equal(result.skipped[0].trackedChange.path, 'nested/part.tex');
  assert.equal(result.skipped[0].result.file, 'nested/part.tex');
  assert.equal(content.run.appliedOperations.length, 2, 'forward write audit remains intact');

  // Reload the actual persisted checkpoint before making native Undo available
  // for the remaining file. The consumed main-file refs no longer exist.
  for (const key of Object.keys(content.run)) delete content.run[key];
  Object.assign(content.run, loaded.run);
  editorUndoPaths.push('nested/part.tex');
  await page.timer.settle(content.undo());
  assert.deepEqual(requests[1].params.expectedFiles.map(file => file.path), ['nested/part.tex']);
  assert.deepEqual(requests[1].params.trackedChanges.map(ref => ref.path), ['nested/part.tex']);
  assert.deepEqual(page.state.editorUndos, ['main.tex', 'nested/part.tex']);
  assert.equal(content.run.trackedChangeStatus, 'rejected', JSON.stringify(responses[1]));
  assert.equal((await content.load()).buttons.undo.disabled, true);
  for (const file of files) assert.equal(page.docs.get(file.path).content, file.before);
  assert.equal(page.state.writes.length, 0, 'Track Undo must not use a snapshot text replacement');
});
}

test('a refs-only reject sweep preserves its known file without inventing content verification', async t => {
  const page = createReviewFixture(t, { files: [{ path: 'nested/part.tex', before: 'old', content: 'oldNEW',
    changes: [{ id: 'owned', op: { p: 3, i: 'NEW' } }] }] });
  t.after(() => page.close());
  await page.ready();
  const result = await page.timer.settle(page.rpc('rejectTrackedChanges', {
    ...page.requestParams(), expectedFiles: [], postFiles: []
  }));
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped[0].trackedChange.path, 'nested/part.tex');
  assert.equal(result.skipped[0].result.file, 'nested/part.tex');
  assert.equal(result.skipped[0].result.code, 'tracked_change_not_found');
  assert.equal(page.docs.get('nested/part.tex').content, 'oldNEW');
});
