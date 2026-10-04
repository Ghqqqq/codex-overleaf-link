'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { createReviewFixture, plain } = require('./_helpers/nativeReviewHarness');
const { buttons, runtime, timeline } = require('./_helpers/reviewActionHarness');
const { harness } = require('./_helpers/undoRuntimeHarness');
const Contract = require('../extension/src/shared/pageRpcContract');
const { extractFunction } = require('./_helpers/extractFunction');

for (const count of [2, 40]) test('ordinary runtime Undo settles honest progress and persists remaining checkpoints for ' + count + ' files', async t => {
  const files = Array.from({ length: count }, (_, i) => ({ path: `section-${i}.tex`, before: `before ${i}\n`, content: `before ${i}\n% added\n`, changes: [] }));
  const page = createReviewFixture(t, { files, reviewing: false, navigationMs: count > 2 ? 1100 : 100 });
  page.state.projectId = 'qa-project'; page.window.location.pathname = '/project/qa-project';
  const h = harness({ track: false, files: files.map(file => ({ path: file.path, content: file.before })),
    operations: files.map(file => ({ type: 'edit', path: file.path, replaceAll: file.content, verifiedContent: file.content })),
    createRouter: () => page.router });
  h.context.Date = Date;
  for (const name of ['buildTrackedUndoPostFiles', 'hasTrackedEditorUndo', 'setRunUndoStatus']) vm.runInContext(extractFunction(runtime, name), h.context);
  vm.runInContext(extractFunction(timeline, 'isTrackedChangeLifecycleRun'), h.context);
  h.context.getPageBridgeTimeoutMs = method => Contract.resolveTimeoutMs(method);
  h.context.callPageBridge = async (method, params) => { const result = await page.rpc(method, params); h.state.results.push(plain(result)); return result; };
  await page.ready();
  await page.timer.settle(h.undo());
  const writes = page.state.writes.length;
  if (count === 2) {
    assert.equal(h.run.undoStatus, 'applied'); assert.equal(buttons(h.run).undo.text, 'Undone');
  } else {
    assert.ok(writes > 0 && writes < count);
    assert.equal(h.run.undoStatus, 'partial'); assert.notEqual(buttons(h.run).undo.text, 'Undone');
    assert.equal(h.state.savedRun.undoStatus, 'partial');
    assert.equal(h.run.undoExpectedFiles.length, count - writes);
    assert.equal(h.state.savedRun.undoExpectedFiles.length, count - writes);
    assert.equal(h.state.events.at(-1).status, 'failed');
    await page.timer.settle(page.timer.sleep(30000)); assert.equal(page.state.writes.length, writes);
    await page.timer.settle(h.undo());
    assert.equal(h.run.undoStatus, 'applied');
    assert.equal(page.state.writes.length, count, 'retry must restore only the remaining files');
  }
  page.close();
});

test('ordinary consumer refuses an unverified transport failure with no skipped entries', async () => {
  const h = harness({ track: false, operations: [{ type: 'edit', path: 'main.tex', replaceAll: 'before\n% mixed\n', verifiedContent: 'before\n% mixed\n' }] });
  for (const name of ['buildTrackedUndoPostFiles', 'hasTrackedEditorUndo', 'setRunUndoStatus']) vm.runInContext(extractFunction(runtime, name), h.context);
  vm.runInContext(extractFunction(timeline, 'isTrackedChangeLifecycleRun'), h.context);
  assert.equal(h.context.isTrackedChangeLifecycleRun(h.run), false);
  assert.equal(h.context.hasTrackedEditorUndo(h.run), true);
  let method;
  h.context.callPageBridge = async (called, params) => { method = called; assert.equal(params.trackedChanges.length, 0);
    return { ok: false, error: 'synthetic transport timeout' }; };
  await h.undo();
  assert.equal(method, 'rejectTrackedChanges');
  assert.equal(h.run.undoStatus, 'partial');
  assert.notEqual(buttons(h.run).undo.text, 'Undone');
  assert.ok(h.run.undoExpectedFiles.length || h.run.undoOperations.length);
  assert.equal(h.state.events.at(-1).status, 'failed');
});
