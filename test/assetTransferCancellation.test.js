'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Broker = require('../extension/src/content/assetTransferBroker');
const Client = require('../extension/src/content/pageBridgeClient');
const Contract = require('../extension/src/shared/pageRpcContract');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = path => ({ type: 'create', path, content: '% synthetic' });
const binary = path => ({ type: 'binary-create', path, contentBase64: 'AA==', size: 1 });

function harness({ cancelOnText = false, cancelOnCommit = false, dropCommit = false, wrongProject = false, cancelActiveCommit = false } = {}) {
  const calls = [], listeners = new Set(), timers = new Map(), tasks = [], receipts = new Map();
  let cancelled = false, sequence = 0, timerSequence = 0;
  const journal = Journal.create({ getProjectId: () => 'p', applyOperations: async operations => {
    const applied = operations.map(operation => ({ operation, result: { ok: true, verifiedContent: operation.content } }));
    if (cancelOnText) cancelled = true;
    return { ok: true, applied, skipped: [], trackedChanges: [{ key: 'track-a', path: operations[0].path }] };
  } });
  const window = {
    location: { origin: 'https://fixture.invalid' },
    addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); },
    setTimeout(fn, ms) { const id = ++timerSequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, queueMicrotask,
    postMessage(message) {
      calls.push(message);
      tasks.push(tick().then(async () => {
        let result;
        const params = message.params;
        if (message.method === 'applyOperations') result = await journal.apply({ ...params, writebackRequestId: message.id });
        else if (message.method === 'getWritebackReceipt') result = journal.get(params);
        else if (message.method === 'binaryUploadBegin' || message.method === 'binaryUploadAppend') result = { ok: true };
        else if (message.method === 'binaryUploadCommit') {
          result = { ok: true, changedDocument: true, path: calls.find(call => call.method === 'binaryUploadBegin').params.path };
          receipts.set(params.transferId, result);
          if (cancelOnCommit) cancelled = true;
          if (cancelActiveCommit) client.cancelActiveRequests();
          if (dropCommit) return;
        } else if (message.method === 'binaryUploadStatus') {
          result = { ok: true, state: 'completed', transferId: params.transferId,
            runProjectId: wrongProject ? 'foreign' : params.runProjectId, result: receipts.get(params.transferId) };
        } else if (message.method === 'binaryUploadAbort') result = { ok: true };
        else throw new Error('Unexpected method ' + message.method);
        await tick();
        for (const listener of [...listeners]) listener({ source: window, origin: window.location.origin,
          data: { source: 'codex-overleaf/page', pageBridgeVersion: 'fixture', pageBridgeRevision: Contract.REVISION,
            id: message.id, result } });
      }));
    }
  };
  const client = Client.create({ window, contract: Contract, compatibility: { BUILD_TARGET_VERSION: 'fixture' },
    crypto: { randomUUID: () => 'rpc-' + (++sequence) }, isCancellationRequested: () => cancelled });
  const broker = Broker.create({ callPageBridge: (method, params) => client.send(method, params,
    Contract.resolveDispatchPolicy(method, { writeback: 45, default: 8 })),
    sendBackgroundNative: async () => { throw new Error('No native I/O allowed'); } });
  return { broker, calls, receipts,
    async waitForCommit() { for (let i = 0; i < 100 && !receipts.size; i++) await tick(); assert.equal(receipts.size, 1); },
    timeoutCommit() { const timer = [...timers.values()].find(timer => timer.ms === 45); assert.ok(timer); timer.fn(); },
    async cleanup() { await Promise.all(tasks); assert.equal(listeners.size, 0); assert.equal(timers.size, 0); }
  };
}

for (const first of ['text', 'binary']) test(`cancel after ${first} write keeps prior results and dispatches no mixed tail`, async () => {
  const h = harness({ cancelOnText: first === 'text', cancelOnCommit: first === 'binary' });
  const operations = first === 'text'
    ? [text('first.tex'), binary('tail.png'), text('last.tex')]
    : [binary('first.png'), text('tail.tex'), binary('last.png')];
  const result = await h.broker.applyOperations({ operations, runProjectId: 'p' });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].operation.path, operations[0].path);
  assert.deepEqual(result.skipped.map(entry => entry.operation.path), operations.slice(1).map(op => op.path));
  assert.ok(result.skipped.every(entry => entry.result.code === 'codex_cancelled' && entry.result.changedDocument === false));
  assert.notEqual(result.receiptUnconfirmed, true);
  const mutations = h.calls.filter(call => ['applyOperations', 'binaryUploadBegin', 'binaryUploadCommit'].includes(call.method));
  assert.deepEqual(mutations.map(call => call.method), first === 'text'
    ? ['applyOperations'] : ['binaryUploadBegin', 'binaryUploadCommit']);
  if (first === 'text') assert.equal(result.trackedChanges.length, 1);
  await h.cleanup();
});

for (const cancel of [false, true]) test(`lost binary commit reply settles with cancellation=${cancel} and preserves tail policy`, async () => {
  const h = harness({ dropCommit: true, cancelOnCommit: cancel });
  const pending = h.broker.applyOperations({ operations: [binary('first.png'), text('tail.tex'), binary('last.png')], runProjectId: 'p' });
  await h.waitForCommit(); h.timeoutCommit();
  // The fixture drops all commits. If the uncancelled tail writes, settle its second commit too.
  if (!cancel) {
    for (let i = 0; i < 100 && h.receipts.size < 2; i++) await tick();
    assert.equal(h.receipts.size, 2); h.timeoutCommit();
  }
  const result = await pending;
  assert.equal(result.applied.length, cancel ? 1 : 3);
  assert.equal(result.receiptRecoveries.length, cancel ? 1 : 2);
  assert.equal(h.calls.filter(call => call.method === 'binaryUploadBegin').length, cancel ? 1 : 2);
  assert.equal(h.calls.filter(call => call.method === 'applyOperations').length, cancel ? 0 : 1);
  assert.equal(result.skipped.length, cancel ? 2 : 0);
  await h.cleanup();
});

test('cancelled binary settlement rejects a receipt from another project and blocks the tail', async () => {
  const h = harness({ dropCommit: true, cancelOnCommit: true, wrongProject: true });
  const pending = h.broker.applyOperations({ operations: [binary('first.png'), text('tail.tex')], runProjectId: 'p' });
  await h.waitForCommit(); h.timeoutCommit();
  const result = await pending;
  assert.equal(result.applied.length, 0);
  assert.equal(result.receiptUnconfirmed, true);
  assert.equal(result.skipped[0].result.changedDocument, true);
  assert.equal(result.skipped[1].result.changedDocument, false);
  assert.equal(h.calls.some(call => call.method === 'applyOperations'), false);
  await h.cleanup();
});

for (const cancelAt of ['begin', 'append']) test(`cancelling binary ${cancelAt} aborts its real Page staging before any commit`, async () => {
  const Uploader = require('../extension/src/page/binaryAssetUploader');
  const uploader = Uploader.create({ window: { atob }, treeOperations: { getProjectId: () => 'p' } });
  const calls = [], listeners = new Set(), tasks = [];
  let cancelled = false, nextId = 0, client, transferId;
  const window = { location: { origin: 'https://fixture.invalid' }, setTimeout, clearTimeout, queueMicrotask,
    addEventListener(_type, fn) { listeners.add(fn); }, removeEventListener(_type, fn) { listeners.delete(fn); },
    postMessage(message) {
      calls.push(message);
      tasks.push(tick().then(async () => {
        let result;
        if (message.method === 'binaryUploadBegin') {
          transferId = message.params.transferId;
          result = uploader.begin(message.params);
          assert.equal(result.ok, true, 'the real Page uploader stage exists before Content cancellation');
          if (cancelAt === 'begin') { cancelled = true; client.cancelActiveRequests(); }
        } else if (message.method === 'binaryUploadAppend') {
          result = uploader.append(message.params);
          assert.equal(result.ok, true);
          cancelled = true;
        } else {
          assert.equal(message.method, 'binaryUploadAbort');
          result = uploader.abort(message.params);
          assert.equal(result.aborted, true, 'cleanup removes the real pending transfer');
        }
        await tick();
        for (const listener of [...listeners]) listener({ source: window, origin: window.location.origin,
          data: { source: 'codex-overleaf/page', pageBridgeVersion: 'fixture', pageBridgeRevision: Contract.REVISION,
            id: message.id, result } });
      }));
    }
  };
  client = Client.create({ window, contract: Contract, compatibility: { BUILD_TARGET_VERSION: 'fixture' },
    crypto: { randomUUID: () => 'rpc-' + (++nextId) }, isCancellationRequested: () => cancelled });
  const broker = Broker.create({ callPageBridge: (method, params) => client.send(method, params, Contract.resolveDispatchPolicy(method)) });
  const result = await broker.applyOperations({ operations: [{ ...binary('first.png'), sha256: 'a'.repeat(64) }, text('tail.tex')], runProjectId: 'p' });
  await Promise.all(tasks);
  assert.deepEqual(calls.map(call => call.method), cancelAt === 'begin'
    ? ['binaryUploadBegin', 'binaryUploadAbort']
    : ['binaryUploadBegin', 'binaryUploadAppend', 'binaryUploadAbort']);
  assert.equal(uploader.append({ transferId, offset: 0, contentBase64: 'AA==' }).code, 'binary_upload_transfer_missing');
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(entry => entry.result.changedDocument === false));
  assert.equal(listeners.size, 0);
});

test('an actively cancelled commit keeps its stop signal after successful receipt settlement', async () => {
  const h = harness({ cancelActiveCommit: true });
  const result = await h.broker.applyOperations({ operations: [binary('first.png'), text('tail.tex'), binary('last.png')], runProjectId: 'p' });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].result.ok, true);
  assert.equal(result.receiptRecoveries.length, 1);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(entry => entry.result.code === 'codex_cancelled' && entry.result.changedDocument === false));
  assert.equal(h.calls.filter(call => call.method === 'binaryUploadBegin').length, 1);
  assert.equal(h.calls.some(call => call.method === 'applyOperations'), false);
  await h.cleanup();
});

test('a rejected duplicate begin cannot abort a different existing transfer', async () => {
  const Uploader = require('../extension/src/page/binaryAssetUploader');
  const uploader = Uploader.create({ window: { atob }, treeOperations: { getProjectId: () => 'p' } });
  const calls = [];
  let transferId;
  const broker = Broker.create({ callPageBridge: async (method, params) => {
    calls.push(method);
    assert.equal(method, 'binaryUploadBegin', 'a definitively rejected begin does not own an abortable stage');
    transferId = params.transferId;
    assert.equal(uploader.begin(params).ok, true);
    return uploader.begin(params);
  } });
  const result = await broker.applyOperations({ operations: [{ ...binary('collision.png'), sha256: 'a'.repeat(64) }], runProjectId: 'p' });
  assert.equal(result.code, 'binary_upload_transfer_conflict');
  assert.deepEqual(calls, ['binaryUploadBegin']);
  assert.equal(uploader.append({ transferId, offset: 0, contentBase64: 'AA==' }).ok, true);
  assert.equal(uploader.abort({ transferId }).aborted, true);
});
