const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../extension/src/content/composerAttachments.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function file(name, size = 4, type = 'text/plain') {
  return { name, size, type, lastModified: 1,
    dataUrl: `data:${type};base64,${Buffer.alloc(size, 65).toString('base64')}` };
}

function fixture(limits = {}) {
  const readers = [];
  const images = [];
  const logs = [];
  class ControlledFileReader {
    readAsDataURL(value) {
      this.file = value;
      readers.push(this);
    }
  }
  class ControlledImage {
    set src(value) {
      this.dataUrl = value;
      this.naturalWidth = 10;
      this.naturalHeight = 10;
      images.push(this);
    }
  }
  const context = vm.createContext({
    window: {}, FileReader: ControlledFileReader, Image: ControlledImage,
    document: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return { getContext: () => ({ drawImage() {} }),
          toDataURL: () => 'data:image/png;base64,cHJldmlldw==' };
      }
    }
  });
  vm.runInContext(source, context, { filename: sourcePath });
  const controller = context.window.CodexOverleafComposerAttachments
    .createComposerAttachmentController({ getPanel: () => null,
      appendPlainLog: value => logs.push(String(value)), limits });
  function complete(reader) {
    assert.ok(reader, 'Expected a pending FileReader');
    assert.ok(!reader.settled, 'FileReader must complete once');
    reader.settled = true;
    reader.result = reader.file.dataUrl;
    reader.onload();
  }
  function fail(reader) {
    assert.ok(reader, 'Expected a pending FileReader');
    assert.ok(!reader.settled, 'FileReader must complete once');
    reader.settled = true;
    reader.error = new Error('Synthetic read failure');
    reader.onerror();
  }
  return { controller, readers, images, logs, complete, fail,
    names: () => plain(controller.getAttachmentsForRun()).map(item => item.name),
    usage: () => plain(controller.getAttachmentByteUsage()) };
}

test('normal attachment retains its content and clear removes a completed attachment', async () => {
  const f = fixture();
  const value = file('normal.txt');
  const adding = f.controller.addFiles([value]);
  f.complete(f.readers[0]);
  await adding;
  assert.deepEqual(f.names(), ['normal.txt']);
  assert.equal(f.controller.getAttachmentsForRun()[0].contentBase64, value.dataUrl.split(',')[1]);
  f.controller.clear();
  assert.deepEqual(f.names(), []);
  assert.equal(f.usage().pending, 0);
});

test('clear invalidates a single pending read before the next run snapshot', async () => {
  const f = fixture();
  const adding = f.controller.addFiles([file('old.txt')]);
  f.controller.clear();
  f.complete(f.readers[0]);
  await adding;
  assert.deepEqual(f.names(), []);
});

test('clear prevents the unstarted remainder of an old sequential batch from reading', async () => {
  const f = fixture();
  const adding = f.controller.addFiles([file('old-first.txt'), file('old-second.txt')]);
  f.controller.clear();
  f.complete(f.readers[0]);
  await flush();
  // Settle any erroneous extra reader so a contract failure cannot hang the test.
  if (f.readers[1]) f.complete(f.readers[1]);
  await adding;
  assert.equal(f.readers.length, 1, 'Cleared batch must not start remaining files');
  assert.deepEqual(f.names(), []);
});

test('clear after FileReader completion but before its continuation skips image preview', async () => {
  const f = fixture();
  const adding = f.controller.addFiles([file('old.png', 4, 'image/png')]);
  f.complete(f.readers[0]);
  f.controller.clear();
  await flush();
  for (const image of f.images) image.onload();
  await adding;
  assert.equal(f.images.length, 0, 'Invalidated read must not launch a preview');
  assert.deepEqual(f.names(), []);
});

test('clear invalidates an already pending image preview and allows a new attachment', async () => {
  const f = fixture();
  const oldAdding = f.controller.addFiles([file('old.png', 4, 'image/png')]);
  f.complete(f.readers[0]);
  await flush();
  assert.equal(f.images.length, 1);
  f.controller.clear();
  const newAdding = f.controller.addFiles([file('new.txt')]);
  f.complete(f.readers[1]);
  await newAdding;
  f.images[0].onload();
  await oldAdding;
  assert.deepEqual(f.names(), ['new.txt']);
});

for (const oldResult of ['success', 'failure']) {
  test(`old read ${oldResult} cannot remove a new same-file reservation or consume its bytes`, async () => {
    const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
    const same = file('same.txt', 4);
    const oldAdding = f.controller.addFiles([same]).catch(error => error);
    f.controller.clear();
    const newAdding = f.controller.addFiles([same]);
    if (oldResult === 'success') f.complete(f.readers[0]);
    else f.fail(f.readers[0]);
    await oldAdding;
    const duplicate = f.controller.addFiles([same]);
    await flush();
    const observed = { readers: f.readers.length, pending: f.usage().pending, names: f.names() };
    for (const reader of f.readers.filter(item => !item.settled)) f.complete(reader);
    await Promise.all([newAdding, duplicate]);
    assert.deepEqual(observed, { readers: 2, pending: 4, names: [] });
    assert.deepEqual(f.names(), ['same.txt']);
    assert.equal(f.usage().pending, 0);
  });
}

test('clear immediately releases the old byte reservation for a full-size new batch', async () => {
  const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
  const oldAdding = f.controller.addFiles([file('old.txt', 8)]);
  f.controller.clear();
  const afterClear = f.usage();
  const newAdding = f.controller.addFiles([file('new.txt', 8)]);
  const newWasStarted = f.readers.length === 2;
  for (const reader of f.readers) f.complete(reader);
  await Promise.all([oldAdding, newAdding]);
  assert.equal(afterClear.pending, 0);
  assert.ok(newWasStarted, 'New generation should not wait for an invalidated FileReader');
  assert.deepEqual(f.names(), ['new.txt']);
  assert.deepEqual(f.usage(), { committed: 8, pending: 0, limit: 8 });
});

test('new batch preserves its aggregate byte limit after old cleanup', async () => {
  const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
  const oldAdding = f.controller.addFiles([file('old.txt', 2)]);
  f.controller.clear();
  const newAdding = f.controller.addFiles([file('new.txt', 6)]);
  f.complete(f.readers[0]);
  await oldAdding;
  const extraAdding = f.controller.addFiles([file('extra.txt', 3)]);
  await extraAdding;
  const reserved = f.usage().pending;
  const readsBeforeCompletion = f.readers.length;
  for (const reader of f.readers.filter(item => !item.settled)) f.complete(reader);
  await newAdding;
  assert.equal(reserved, 6);
  assert.equal(readsBeforeCompletion, 2, 'Extra bytes must remain over the new generation budget');
  assert.deepEqual(f.names(), ['new.txt']);
});

test('clear across two waves of eight concurrent calls returns only the new eight', async () => {
  const f = fixture();
  const oldAdding = Array.from({ length: 8 }, (_, i) => f.controller.addFiles([file(`old-${i}.txt`)]));
  f.controller.clear();
  const newAdding = Array.from({ length: 8 }, (_, i) => f.controller.addFiles([file(`new-${i}.txt`)]));
  assert.equal(f.readers.length, 16, 'Both waves were admitted, with old work invalidated');
  for (let i = 0; i < 8; i++) {
    f.complete(f.readers[8 + i]);
    await flush();
    f.complete(f.readers[i]);
    await flush();
  }
  await Promise.all([...oldAdding, ...newAdding]);
  assert.deepEqual(f.names(), Array.from({ length: 8 }, (_, i) => `new-${i}.txt`));
  assert.deepEqual(f.usage(), { committed: 32, pending: 0, limit: 32 * 1024 * 1024 });
});

test('ordinary sequential batch keeps count eight and reads one file at a time', async () => {
  const f = fixture();
  const adding = f.controller.addFiles(Array.from({ length: 9 }, (_, i) => file(`file-${i}.txt`)));
  for (let i = 0; i < 8; i++) {
    assert.equal(f.readers.length, i + 1);
    f.complete(f.readers[i]);
    await flush();
  }
  await adding;
  assert.equal(f.readers.length, 8);
  assert.equal(f.names().length, 8);
  assert.match(f.logs.join('\n'), /Attachment limit reached/);
});

test('ordinary concurrent calls reserve eight slots and deduplicate unfinished reads', async () => {
  const f = fixture();
  const files = Array.from({ length: 9 }, (_, i) => file(`file-${i}.txt`));
  const adding = files.map(value => f.controller.addFiles([value]));
  await f.controller.addFiles([files[0]]);
  assert.equal(f.readers.length, 8);
  for (const reader of f.readers) f.complete(reader);
  await Promise.all(adding);
  assert.equal(f.names().length, 8);
});

test('ordinary concurrent calls reserve aggregate bytes until completion', async () => {
  const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
  const adding = f.controller.addFiles([file('first.txt', 6)]);
  await f.controller.addFiles([file('too-large.txt', 3)]);
  assert.equal(f.readers.length, 1);
  assert.equal(f.usage().pending, 6);
  f.complete(f.readers[0]);
  await adding;
  assert.deepEqual(f.usage(), { committed: 6, pending: 0, limit: 8 });
});

test('current read failure releases its reservation and permits same-file retry', async () => {
  const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
  const value = file('retry.txt', 8);
  const adding = f.controller.addFiles([value]);
  const rejected = assert.rejects(adding, /Synthetic read failure/);
  f.fail(f.readers[0]);
  await rejected;
  assert.deepEqual(f.usage(), { committed: 0, pending: 0, limit: 8 });
  const retry = f.controller.addFiles([value]);
  f.complete(f.readers[1]);
  await retry;
  assert.deepEqual(f.names(), ['retry.txt']);
});

test('a cleared read failure is ignored and does not affect the new generation', async () => {
  const f = fixture();
  const oldAdding = f.controller.addFiles([file('old.txt')]);
  const settled = oldAdding.then(() => 'resolved', error => error.message);
  f.controller.clear();
  const newAdding = f.controller.addFiles([file('new.txt')]);
  f.fail(f.readers[0]);
  const oldOutcome = await settled;
  f.complete(f.readers[1]);
  await newAdding;
  assert.equal(oldOutcome, 'resolved', 'Discarded work must not report a new composer error');
  assert.deepEqual(f.names(), ['new.txt']);
});

test('normal image preview remains available and preview decode failure keeps the existing fallback', async () => {
  const f = fixture();
  const first = f.controller.addFiles([file('normal.png', 4, 'image/png')]);
  f.complete(f.readers[0]);
  await flush();
  f.images[0].onload();
  await first;
  const secondFile = file('fallback.png', 4, 'image/png');
  const second = f.controller.addFiles([secondFile]);
  f.complete(f.readers[1]);
  await flush();
  f.images[1].onerror();
  await second;
  const entries = f.controller.getAttachmentsForRun();
  assert.equal(entries[0].previewDataUrl, 'data:image/png;base64,cHJldmlldw==');
  assert.equal(entries[1].previewDataUrl, secondFile.dataUrl);
  assert.deepEqual(f.names(), ['normal.png', 'fallback.png']);
});
