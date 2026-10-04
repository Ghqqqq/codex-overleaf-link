'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, TARGET, BEFORE, COLLAB, NEW, hash } = require('./_helpers/binaryWritebackHarness');

test('native baseline hash survives real asset registration, chunk streaming and Page dispatch', async t => {
  const h = await harness(t, { native: true });
  const result = await h.upload();
  assert.equal(h.nativeChanges[0].previousSha256, hash(BEFORE));
  assert.equal(h.calls.find(call => call.method === 'binaryUploadBegin').params.previousSha256, hash(BEFORE));
  assert.ok(h.nativeChunks.length > 1);
  assert.equal(result.ok, true); assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].beforeHash, hash(BEFORE));
  assert.equal(hash(h.server.get(TARGET)), hash(NEW));
  assert.ok(h.reads.some(read => !read.afterUpload && read.hash === hash(BEFORE)));
  assert.ok(h.reads.some(read => read.afterUpload && read.hash === hash(NEW)));
  await h.cleanup();
});
for (const mutateAt of ['confirmation', 'before-replace']) test(`concurrent binary change at ${mutateAt} blocks replacement`, async t => {
  const h = await harness(t, { native: true, mutateAt });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.uploads.length, 0);
  assert.equal(hash(h.server.get(TARGET)), hash(COLLAB));
  assert.equal(result.applied.length, 0);
  await h.cleanup();
});
for (const option of ['cancelBeforeCommit', 'abortBeforeCommit', 'changeProjectBeforeCommit', 'changeProjectInPrepare']) {
  test(`binary baseline integration preserves ${option} rejection`, async t => {
    const h = await harness(t, { native: true, [option]: true });
    const result = await h.upload();
    assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); assert.equal(hash(h.server.get(TARGET)), hash(BEFORE));
    await h.cleanup();
  });
}
test('rejecting overwrite confirmation never starts a Native asset stream or Page upload', async t => {
  const h = await harness(t, { native: true, approved: false });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.nativeChunks.length, 0); assert.equal(h.uploads.length, 0);
  assert.equal(h.calls.some(call => call.method === 'binaryUploadBegin'), false);
  await h.cleanup();
});

for (const failed of [false, true]) test(`new binary directory proofs survive ${failed ? 'pre-upload failure' : 'successful upload'}`, async t => {
  const h = await harness(t, { create: true, targetPath: 'generated/figure.png', createdDirectory: 'generated', failAfterDirectory: failed });
  const result = await h.upload();
  const evidence = (failed ? result.skipped : result.applied)[0].result;
  assert.equal(result.ok, !failed);
  assert.deepEqual(evidence.createdDirectories, [{ v: 1, projectId: 'synthetic-original-project', path: 'generated', nativeFolderId: 'new-folder-id',
    ownershipConfirmed: false, observedAfterCreate: true }]);
  assert.equal(evidence.folderChanged, true); assert.equal(evidence.fileUploadAttempted, !failed);
  assert.equal(evidence.directoryCleanupRequired, failed);
  assert.equal(h.directoryCleanups.length, failed ? 1 : 0);
  if (failed) assert.equal(h.directoryCleanups[0].current, true);
  assert.equal(h.uploads.length, failed ? 0 : 1);
  await h.cleanup();
});

test('directory-only failure cannot adopt a collaborator file from a matching later hash', async t => {
  const h = await harness(t, { create: true, targetPath: 'generated/figure.png', createdDirectory: 'generated', failAfterDirectory: true });
  const failed = await h.upload(); assert.equal(failed.ok, false); assert.equal(h.uploads.length, 0);
  h.server.set('generated/figure.png', Buffer.from(NEW));
  const transferId = h.calls.find(call => call.method === 'binaryUploadBegin').params.transferId;
  const receipt = await h.dispatch('binaryUploadStatus', { transferId, runProjectId: 'synthetic-original-project' });
  assert.equal(receipt.result.ok, false); assert.equal(receipt.result.fileUploadAttempted, false);
  assert.equal(receipt.result.folderChanged, true); assert.equal(h.uploads.length, 0);
  await h.cleanup();
});
