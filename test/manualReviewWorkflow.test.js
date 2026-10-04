'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewFixture } = require('./_helpers/nativeReviewHarness');
const { acceptController } = require('./_helpers/reviewActionHarness');

// Retiring the extra reconciliation flow keeps the original automatic Accept
// boundary and its real Undo checkpoints intact.
test('unsupported native acceptance stops without an extra manual reconciliation workflow', async t => {
  const page = createReviewFixture(t, { files: [{ path: 'main.tex', before: 'aold', content: 'aNEWold', changes: [
    { id: 'change-insert-1', snapshotRange: { from: 1, to: 4 }, op: { p: 1, i: 'NEW' } },
    { id: 'unrelated', op: { p: 4, i: 'old' } }
  ] }] });
  await page.ready();
  const action = acceptController(page, page.requestParams());
  const expected = JSON.stringify(action.run.undoExpectedFiles);
  const refs = JSON.stringify(action.run.undoTrackedChanges);
  const applied = JSON.stringify(action.run.appliedOperations);
  await page.timer.settle(action.accept());
  assert.equal(action.run.trackedChangeStatus, 'pending');
  assert.equal(action.run.manualReviewProof, undefined);
  assert.equal(JSON.stringify(action.run.undoExpectedFiles), expected);
  assert.equal(JSON.stringify(action.run.undoTrackedChanges), refs);
  assert.equal(JSON.stringify(action.run.appliedOperations), applied);
  assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
  assert.equal(page.docs.get('main.tex').content, 'aNEWold');
  assert.equal(action.context.getRunReviewController().verifyManualReview, undefined);
  assert.equal(action.context.getRunReviewController().openManualReviewFile, undefined);
  page.close();
});

test('an old manual-verification request is rejected without falling through to mutating Accept', async t => {
  const page = createReviewFixture(t, { files: [{ path: 'main.tex', before: 'old', content: 'NEWold', changes: [
    { id: 'change-insert-0', op: { p: 0, i: 'NEW' } }
  ] }] });
  await page.ready();
  const result = await page.timer.settle(page.rpc('acceptTrackedChanges', {
    ...page.requestParams(), verifyManualReview: true,
    manualReviewProof: { v: 1, files: [] }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.skipped[0].result.code, 'native_accept_protocol_unsupported');
  assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
  assert.equal(page.docs.get('main.tex').content, 'NEWold');
  assert.equal(page.docs.get('main.tex').changes.length, 1);
  page.close();
});
