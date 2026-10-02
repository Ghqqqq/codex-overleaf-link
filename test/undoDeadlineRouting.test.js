'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Client = require('../extension/src/content/pageBridgeClient');
const Contract = require('../extension/src/shared/pageRpcContract');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const Router = require('../extension/src/page/writebackRouter');
const Broker = require('../extension/src/content/assetTransferBroker');
const StaleGuard = require('../extension/src/shared/staleGuard');
const ProjectFiles = require('../extension/src/shared/projectFiles');
const { extractFunction } = require('./_helpers/extractFunction');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');

function transport() {
  const sent = [], timers = new Map(), listeners = new Set();
  let clock = 100, sequence = 0;
  const window = { location: { origin: 'https://www.overleaf.com' },
    setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    postMessage(message) { sent.push(message); }, queueMicrotask };
  const client = Client.create({ window, now: () => clock, contract: Contract,
    compatibility: { BUILD_TARGET_VERSION: '2.5.0' }, crypto: { randomUUID: () => 'id-' + (++sequence) } });
  return { client, sent, timers, policy: method => Contract.resolveDispatchPolicy(method),
    expire() { const pending = [...timers.values()]; for (const timer of pending) { clock += timer.ms; timer.fn(); } } };
}

test('RPC waiting uses the smaller of the shared deadline and transport limit', async () => {
  const h = transport();
  const pending = h.client.send('applyOperations', { deadlineAt: 1100 }, h.policy('applyOperations'));
  assert.equal([...h.timers.values()][0].ms, 1000);
  h.expire();
  const result = await pending;
  assert.equal(result.code, 'page_bridge_timeout');
  assert.equal(result.requestId, h.sent[0].id);
  assert.equal(h.sent.length, 1);
});
test('ordinary requests retain the existing transport limit', async () => {
  const h = transport();
  const pending = h.client.send('applyOperations', {}, h.policy('applyOperations'));
  assert.equal([...h.timers.values()][0].ms, 45000);
  h.expire(); await pending;
});
for (const deadlineAt of [0, 100, NaN, 'invalid']) {
  test('an expired or invalid deadline never dispatches: ' + String(deadlineAt), async () => {
    const h = transport();
    const result = await h.client.send('applyOperations', { deadlineAt }, h.policy('applyOperations'));
    assert.equal(result.code, 'writeback_deadline_exceeded');
    assert.equal(result.changedDocument, false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.timers.size, 0);
  });
}
test('receipt reads are capped by the same deadline and cancellation remains effective', async () => {
  const h = transport();
  const pending = h.client.send('getWritebackReceipt', { deadlineAt: 600 }, h.policy('getWritebackReceipt'));
  assert.equal([...h.timers.values()][0].ms, 500);
  const rejected = assert.rejects(pending, { code: 'codex_cancelled' });
  h.client.cancelActiveRequests(); await rejected;
  assert.equal(h.timers.size, 0);
});
test('journal preserves the deadline and does not mutate after preparation consumes it', async () => {
  let clock = 0, applies = 0;
  const journal = Journal.create({ now: () => clock, getProjectId: () => 'p',
    prepareEditor: async () => { clock = 100; return { ok: true }; },
    applyOperations: async () => { applies++; return { ok: true }; } });
  const params = { writebackRequestId: 'undo', runProjectId: 'p', deadlineAt: 100,
    reviewingPolicy: 'no-trace-undo', operations: [{ type: 'delete', path: 'a.tex' }] };
  const result = await journal.apply(params);
  assert.equal(result.code, 'writeback_deadline_exceeded');
  assert.equal(result.changedDocument, false);
  assert.equal(applies, 0);
  assert.equal(journal.get({ requestId: 'undo', runProjectId: 'p' }).state, 'completed');
  assert.deepEqual(await journal.apply(params), result, 'duplicate delivery reads the original receipt');
});
test('journal forwards a live deadline and refuses expired work before editor preparation', async () => {
  let preparations = 0, appliedOptions;
  const journal = Journal.create({ now: () => 10, getProjectId: () => 'p',
    prepareEditor: async () => { preparations++; return { ok: true }; },
    applyOperations: async (_ops, options) => { appliedOptions = options; return { ok: true }; } });
  const result = await journal.apply({ writebackRequestId: 'old', runProjectId: 'p', deadlineAt: 10 });
  assert.equal(result.code, 'writeback_deadline_exceeded');
  assert.equal(preparations, 0);
  await journal.apply({ writebackRequestId: 'live', runProjectId: 'p', deadlineAt: 100,
    reviewingPolicy: 'no-trace-undo', operations: [] });
  assert.equal(appliedOptions.deadlineAt, 100);
  assert.equal(preparations, 1);
});
test('router stops the undispatched tail and forwards the shared deadline to deletion', async () => {
  let clock = 0;
  const deletes = [], operations = ['a.png', 'b.png'].map(path => ({ type: 'delete', path,
    undoCreatedFile: { v: 1, kind: 'binary', sha256: 'a'.repeat(64) } }));
  const router = Router.create({ now: () => clock,
    window: { document: {}, CodexOverleafStaleGuard: StaleGuard, CodexOverleafProjectFiles: ProjectFiles },
    treeOperations: { getProjectId: () => 'p' },
    deleteTextFile: async (operation, options) => {
      assert.equal(options.deadlineAt, 60); assert.equal(options.canDelete(), true);
      deletes.push(operation.path); clock = 70;
      return { ok: true, verified: true, verification: 'overleaf-zip', changedDocument: true };
    } });
  const result = await router.applyOperations({ operations, baseFiles: [], runProjectId: 'p', deadlineAt: 60 });
  assert.deepEqual(deletes, ['a.png']);
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped[0].operation.path, 'b.png');
  assert.equal(result.skipped[0].result.code, 'writeback_deadline_exceeded');
});
test('the production Undo bridge recovers the original receipt without redispatching deletion', async () => {
  const calls = [], operation = { type: 'delete', path: 'new.tex', undoCreatedFile: { v: 1, kind: 'text' } };
  const deadlineAt = Date.now() + 120000;
  const context = vm.createContext({ Modules: { AssetTransferBroker: Broker },
    sendBackgroundNative() { assert.fail('no binary transfer is needed for an inverse delete'); },
    pageBridgeClient: { async call(method, params) {
      calls.push({ method, params });
      if (method === 'applyOperations') return { ok: false, code: 'page_bridge_timeout', requestId: 'original', error: 'timeout' };
      assert.equal(method, 'getWritebackReceipt');
      return { ok: true, requestId: 'original', runProjectId: 'p', state: 'completed', result: {
        ok: true, applied: [{ operation, result: { ok: true, verified: true, verification: 'overleaf-zip' } }], skipped: [],
        reviewingPolicy: { policy: 'no-trace-undo' } } };
    } } });
  vm.runInContext(extractFunction(runtime, 'callPageBridge'), context);
  const result = await context.callPageBridge('applyOperations', {
    operations: [operation], reviewingPolicy: 'no-trace-undo', runProjectId: 'p', deadlineAt });
  assert.deepEqual(calls.map(call => call.method), ['applyOperations', 'getWritebackReceipt']);
  assert.ok(calls.every(call => call.params.deadlineAt === deadlineAt));
  assert.equal(calls[1].params.requestId, 'original');
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.reviewingPolicy.policy, 'no-trace-undo');
});
