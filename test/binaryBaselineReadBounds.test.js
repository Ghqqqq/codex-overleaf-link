'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, TARGET, BEFORE, COLLAB, NEW, PROJECT, hash, until } = require('./_helpers/binaryWritebackHarness');

for (const mode of ['changeIdentity', 'replaceInput']) test(`binary preflight rejects ${mode} while reading the baseline`, async t => {
  let changed = false;
  const h = await harness(t, { native: true, onBaselineRead(io) { if (!changed) { changed = true; io[mode](); } } });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); assert.equal(hash(h.server.get(TARGET)), hash(BEFORE));
  await h.cleanup();
});
for (const dialog of ['wrongDialog', 'duplicateDialog']) test(`binary replacement does not click ${dialog}`, async t => {
  const h = await harness(t, { native: true, [dialog]: true });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); assert.equal(hash(h.server.get(TARGET)), hash(BEFORE));
  await h.cleanup();
});
for (const stalled of ['fetch', 'body']) test(`binary ${stalled} read has an abortable deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started = false, signal, cancelled = 0;
  const h = await harness(t, { native: true, onBaselineRead({ request }) {
    started = true; signal = request.signal;
    if (stalled === 'fetch') return new Promise(() => {});
    return { ok: true, body: new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled++; } }) };
  } });
  const pending = h.upload(); await until(() => started, 'baseline read');
  t.mock.timers.tick(8000);
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(signal.aborted, true); assert.equal(h.uploads.length, 0);
  if (stalled === 'body') assert.ok(cancelled > 0);
  await h.cleanup();
});
for (const mode of ['declared-size', 'streamed-size']) test(`binary baseline rejects excessive ${mode} without uploading`, async t => {
  const h = await harness(t, { native: true, onBaselineRead() {
    if (mode === 'declared-size') return { ok: true, headers: { get: () => String(10 * 1024 * 1024 + 1) }, arrayBuffer() { assert.fail('oversized declared payload must not be read'); } };
    return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); controller.close(); } }) };
  } });
  const result = await h.upload(); assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); await h.cleanup();
});
test('conflicting Native and browser baseline hashes stop before Page staging', async t => {
  const h = await harness(t);
  const result = await h.broker.applyOperations({ operations: [{ type: 'overwrite-binary', path: TARGET,
    previousSha256: hash(COLLAB), sha256: hash(NEW), size: NEW.length, contentBase64: NEW.toString('base64') }],
    baseFiles: h.project.files, runProjectId: PROJECT });
  assert.equal(result.code, 'binary_asset_baseline_conflict'); assert.equal(h.calls.some(call => call.method === 'binaryUploadBegin'), false);
  assert.equal(h.uploads.length, 0); await h.cleanup();
});
test('direct Page overwrite without a previous hash is refused before transfer staging', async t => {
  const h = await harness(t);
  const result = await h.dispatch('binaryUploadBegin', { transferId: 'missing-baseline', path: TARGET, overwrite: true,
    sha256: hash(NEW), size: NEW.length, runProjectId: PROJECT });
  assert.equal(result.code, 'binary_asset_baseline_missing');
  const aborted = await h.dispatch('binaryUploadAbort', { transferId: 'missing-baseline', runProjectId: PROJECT });
  assert.equal(aborted.aborted, false); await h.cleanup();
});
test('new-payload checksum rejection remains distinct from old-baseline comparison', async t => {
  const h = await harness(t, { badHash: true });
  const result = await h.upload();
  assert.equal(result.code, 'binary_upload_checksum_mismatch'); assert.equal(h.reads.length, 0); assert.equal(h.uploads.length, 0);
  await h.cleanup();
});

for (const atRead of [1, 2]) test(`same-project upload folder drift during baseline read ${atRead} blocks DOM dispatch`, async t => {
  let reads = 0;
  const h = await harness(t, { native: true, onBaselineRead(io) { if (++reads === atRead) io.switchUploadParent(); } });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); assert.equal(hash(h.server.get(TARGET)), hash(BEFORE));
  assert.equal(h.events.includes('DOM-replace'), false);
  if (atRead === 1) assert.equal(h.events.includes('DOM-change'), false);
  await h.cleanup();
});
test('a replacement dialog changing during the second baseline read is not clicked', async t => {
  let reads = 0;
  const h = await harness(t, { native: true, onBaselineRead(io) { if (++reads === 2) io.changeDialog(); } });
  const result = await h.upload(); assert.equal(result.ok, false); assert.equal(h.uploads.length, 0);
  assert.equal(h.events.includes('DOM-replace'), false); await h.cleanup();
});

test('a generic basename node cannot authorize replacement when exact metadata names another folder', async t => {
  const h = await harness(t, { native: true, metadataPath: 'other/figure.png' });
  const result = await h.upload();
  assert.equal(result.ok, false); assert.equal(h.uploads.length, 0); assert.equal(h.reads.length, 0);
  assert.equal(hash(h.server.get(TARGET)), hash(BEFORE)); await h.cleanup();
});
test('exact path metadata supplies the binary identity when a native tree is unavailable', async t => {
  const h = await harness(t, { native: true });
  const result = await h.upload();
  assert.equal(result.ok, true); assert.equal(h.uploads.length, 1);
  assert.ok(h.reads.some(read => !read.afterUpload && read.hash === hash(BEFORE)));
  await h.cleanup();
});
