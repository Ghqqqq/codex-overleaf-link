'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runController = require('../extension/src/content/runController');

const sourcePath = path.join(__dirname, '../extension/src/content/composerAttachments.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.hidden = true;
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.attributes = {};
    this.listeners = {};
  }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelector() { return null; }
}

function file(name, size = 4) {
  return { name, size, type: 'text/plain', lastModified: 1,
    dataUrl: `data:text/plain;base64,${Buffer.alloc(size, 65).toString('base64')}` };
}

function fixture(limits = {}) {
  const readers = [], logs = [], strip = new Element(), form = new Element();
  class Reader {
    readAsDataURL(value) { this.file = value; readers.push(this); }
  }
  const panel = { querySelector: selector => selector === '[data-attachment-strip]' ? strip
    : selector === '[data-composer-form]' ? form : null };
  const context = vm.createContext({ window: {}, FileReader: Reader,
    document: { body: new Element(), createElement: tag => new Element(tag) } });
  vm.runInContext(source, context, { filename: sourcePath });
  const controller = context.window.CodexOverleafComposerAttachments.createComposerAttachmentController({
    getPanel: () => panel, appendPlainLog: value => logs.push(String(value)), limits
  });
  function settle(index, fail = false) {
    const reader = readers[index];
    assert.ok(reader && !reader.settled, 'Expected one unsettled FileReader');
    reader.settled = true;
    if (fail) {
      reader.error = new Error('Synthetic read failure');
      reader.onerror();
    } else {
      reader.result = reader.file.dataUrl;
      reader.onload();
    }
  }
  function renderedNames() {
    const found = [];
    function walk(node) {
      if (node.className === 'codex-attachment-preview-name') found.push(node.textContent);
      for (const child of node.children) walk(child);
    }
    walk(strip);
    return found;
  }
  function assertReady(expected) {
    const attachments = plain(controller.getAttachmentsForRun());
    const params = runController.buildCodexRunParams({
      currentProjectId: 'synthetic-project', state: { mode: 'ask' }, task: 'Use the visible attachments', attachments
    });
    assert.deepEqual(renderedNames(), expected, 'Visible names must match accepted inputs');
    assert.deepEqual(attachments.map(item => item.name), expected);
    assert.deepEqual((params.attachments || []).map(item => item.name), expected,
      'Production request construction must send exactly the visible attachment list');
    assert.deepEqual(params.attachments || [], attachments.map(({ name, mimeType, size, contentBase64 }) =>
      ({ name, mimeType, size, contentBase64 })), 'Request construction must preserve accepted content');
    assert.equal(strip.hidden, expected.length === 0);
  }
  return { controller, readers, logs, strip, settle, assertReady,
    usage: () => plain(controller.getAttachmentByteUsage()) };
}

test('valid sequential batch renders every accepted attachment and preserves request content', async () => {
  const f = fixture();
  const adding = f.controller.addFiles([file('first.txt'), file('second.txt')]);
  f.settle(0);
  await flush();
  f.settle(1);
  await adding;
  f.assertReady(['first.txt', 'second.txt']);
  assert.equal(f.controller.getAttachmentsForRun()[0].contentBase64, Buffer.alloc(4, 65).toString('base64'));
});

for (const fault of ['empty', 'too-large', 'read-failure']) {
  test(`drop keeps accepted prefix visible after ${fault}, reports failure and stops the remaining batch`, async () => {
    const f = fixture({ maxAttachmentBytes: 8 });
    const bad = file('bad.txt', fault === 'empty' ? 0 : fault === 'too-large' ? 9 : 4);
    let prevented = false;
    f.controller.handleDrop({ dataTransfer: { files: [file('first.txt'), bad, file('tail.txt')] },
      preventDefault() { prevented = true; } });
    f.settle(0);
    await flush();
    if (fault === 'read-failure') { f.settle(1, true); await flush(); }
    assert.equal(prevented, true);
    assert.equal(f.logs.length, 1);
    assert.match(f.logs[0], /Attachment was not added/);
    assert.match(f.logs[0], fault === 'empty' ? /Empty attachments/ : fault === 'too-large' ? /too large/ : /Could not read selected file/);
    assert.deepEqual(f.readers.map(reader => reader.file.name), fault === 'read-failure'
      ? ['first.txt', 'bad.txt'] : ['first.txt']);
    assert.equal(f.usage().pending, 0);
    f.assertReady(['first.txt']);
  });
}

test('direct addFiles still rejects validation errors after rendering accepted inputs', async () => {
  const f = fixture();
  const adding = f.controller.addFiles([file('first.txt'), file('empty.txt', 0)]);
  const rejected = assert.rejects(adding, /Empty attachments/);
  f.settle(0);
  await rejected;
  f.assertReady(['first.txt']);
});

test('first-file rejection leaves an empty tray and permits a valid retry', async () => {
  const f = fixture();
  await assert.rejects(f.controller.addFiles([file('empty.txt', 0)]), /Empty attachments/);
  f.assertReady([]);
  const adding = f.controller.addFiles([file('retry.txt')]);
  f.settle(0);
  await adding;
  f.assertReady(['retry.txt']);
});

for (const oldResult of ['success', 'failure']) {
  test(`cleared batch ${oldResult} cannot replace new tray nodes or change its budget`, async () => {
    const f = fixture({ maxAttachmentTotalBytes: 8, maxAttachmentBytes: 8 });
    const oldAdding = f.controller.addFiles([file('old.txt'), file('old-tail.txt')]);
    f.controller.clear();
    const newAdding = f.controller.addFiles([file('new.txt', 8)]);
    f.settle(1);
    await newAdding;
    f.assertReady(['new.txt']);
    const currentCard = f.strip.children[0];
    f.settle(0, oldResult === 'failure');
    await oldAdding;
    assert.equal(f.strip.children[0], currentCard, 'Discarded work must not rebuild the current tray');
    assert.equal(f.readers.length, 2, 'Discarded batch must not start its remaining files');
    assert.deepEqual(f.usage(), { committed: 8, pending: 0, limit: 8 });
    f.assertReady(['new.txt']);
  });
}

test('a partial failure preserves previously visible attachments and permits the failed file retry', async () => {
  const f = fixture();
  const first = f.controller.addFiles([file('existing.txt')]);
  f.settle(0);
  await first;
  const adding = f.controller.addFiles([file('accepted.txt'), file('retry.txt')]);
  const rejected = assert.rejects(adding, error => error.message === 'Could not read selected file.'
    && error.cause?.message === 'Synthetic read failure');
  f.settle(1);
  await flush();
  f.settle(2, true);
  await rejected;
  f.assertReady(['existing.txt', 'accepted.txt']);
  const retry = f.controller.addFiles([file('retry.txt')]);
  f.settle(3);
  await retry;
  f.assertReady(['existing.txt', 'accepted.txt', 'retry.txt']);
});
