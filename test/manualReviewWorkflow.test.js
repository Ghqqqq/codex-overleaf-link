'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewFixture } = require('./_helpers/nativeReviewHarness');
const { acceptController } = require('./_helpers/reviewActionHarness');
async function fixture(t) {
  const page = createReviewFixture(t, { files: [{ path: 'main.tex', before: 'aold', content: 'aNEWold', changes: [
    { id: 'change-insert-1', snapshotRange: { from: 1, to: 4 }, op: { p: 1, i: 'NEW' } },
    { id: 'unrelated', op: { p: 4, i: 'old' } }
  ] }] }); await page.ready();
  const action = acceptController(page, page.requestParams());
  await page.timer.settle(action.accept());
  return { page, action };
}

test('unsupported automatic Accept retains durable proof and verifies manual native review after reload without mutation', async t => {
  const { page, action } = await fixture(t);
  assert.equal(action.run.trackedChangeStatus, 'pending');
  assert.ok(action.run.manualReviewProof);
  assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
  assert.ok(action.saved.at(-1).runs[0].manualReviewProof);
  action.reload();
  assert.ok(action.run.undoExpectedFiles.length);
  assert.ok(action.run.appliedOperations.length);
  const file = page.docs.get('main.tex');
  file.changes = file.changes.filter(change => change.id !== 'change-insert-1');
  const result = await page.timer.settle(action.verify());
  assert.equal(result.ok, true);
  assert.equal(action.run.trackedChangeStatus, 'accepted');
  assert.equal(action.saved.at(-1).runs[0].trackedChangeStatus, 'accepted');
  assert.equal(file.content, 'aNEWold');
  assert.deepEqual(file.changes.map(change => change.id), ['unrelated']);
  assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
  page.close();
});

for (const scenario of ['targets-remain', 'unrelated-removed', 'text-changed', 'document-replaced', 'postimage-lost']) {
  test('manual verification retains recovery when ' + scenario, async t => {
    const { page, action } = await fixture(t); action.reload();
    const file = page.docs.get('main.tex');
    if (scenario !== 'targets-remain') file.changes = file.changes.filter(change => change.id !== 'change-insert-1');
    if (scenario === 'unrelated-removed') file.changes = [];
    if (scenario === 'text-changed') file.content += 'later edit';
    if (scenario === 'document-replaced') file.id += '-replacement';
    if (scenario === 'postimage-lost') action.run.appliedOperations = [];
    const result = await page.timer.settle(action.verify());
    assert.equal(result.ok, false);
    assert.equal(action.run.trackedChangeStatus, 'pending');
    assert.ok(action.run.manualReviewProof);
    assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
    page.close();
  });
}

test('manual review rejects a changed project before dispatch and preserves the original record', async t => {
  const { page, action } = await fixture(t); page.state.projectId = 'other';
  const count = page.posted.length;
  await assert.rejects(action.verify(), /project, account or session changed/);
  assert.equal(page.posted.length, count);
  assert.equal(action.run.trackedChangeStatus, 'pending');
  page.close();
});

test('a writer that drops manual proof cannot acknowledge its durable recovery path', async t => {
  const page = createReviewFixture(t, { files: [{ path: 'main.tex', before: 'old', content: 'NEWold', changes: [
    { id: 'change-insert-0', snapshotRange: { from: 0, to: 3 }, op: { p: 0, i: 'NEW' } }
  ] }] });
  await page.ready(); const action = acceptController(page, page.requestParams());
  const write = action.storage.putRecords;
  action.storage.putRecords = (store, records) => write(store, records.map(record => ({ ...record, runs: record.runs.map(run => {
    const copy = { ...run }; delete copy.manualReviewProof; return copy;
  }) })));
  await assert.rejects(page.timer.settle(action.accept()), /not durably saved/);
  assert.equal(action.run.trackedChangeStatus, 'needs_review');
  assert.ok(action.run.manualReviewProof);
  assert.equal(page.state.fetches.length + page.state.writes.length + page.state.dispatches.length, 0);
  page.close();
});
