const test = require('node:test');
const assert = require('node:assert/strict');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const Broker = require('../extension/src/content/assetTransferBroker');
const Client = require('../extension/src/content/pageBridgeClient');
const Contract = require('../extension/src/shared/pageRpcContract');
const version = require('../package.json').version;

const ops = [
  ...['a.tex', 'b.tex', 'c.tex'].map(name => ({ type: 'create', path: 'Figures/QA/' + name, content: '% QA' })),
  { type: 'create', path: 'Style/qa.sty', content: '% QA' },
  { type: 'edit', path: 'notes.tex', patches: [{ from: 0, to: 0, insert: '% QA\n' }] },
  { type: 'edit', path: 'sub/nested.tex', patches: [{ from: 0, to: 0, insert: '% QA\n' }] }
];
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

function harness(execute, options = {}) {
  let project = 'project-a', nextId = 0, timerId = 0, now = 0, executions = 0;
  const listeners = new Set(), timers = new Map(), calls = [], serverCalls = [];
  const journal = Journal.create({
    getProjectId: () => project,
    prepareEditor: async () => ({ ok: true }),
    applyOperations: async (operations, params) => {
      executions++;
      return execute(operations, params);
    }
  });
  const window = {
    location: { origin: 'https://www.overleaf.com' },
    addEventListener(_type, fn) { listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueMicrotask,
    postMessage(message) {
      calls.push(message);
      const deliver = result => {
        if (options.dropApplyReply && message.method === 'applyOperations') return;
        for (const listener of [...listeners]) listener({
          source: window, origin: window.location.origin, data: {
            source: 'codex-overleaf/page', pageBridgeVersion: version,
            pageBridgeRevision: Contract.REVISION, id: message.id, result
          }
        });
      };
      if (message.method === 'applyOperations') {
        const work = journal.apply({ ...message.params, writebackRequestId: message.id }).then(deliver);
        serverCalls.push(work);
      } else if (message.method === 'getWritebackReceipt') {
        options.onReceipt?.({ journal, message, setProject: value => { project = value; } });
        deliver(options.receiptResponse || journal.get(message.params));
      } else throw new Error('Unexpected method ' + message.method);
    }
  };
  const client = Client.create({ window, document: {}, chromeApi: { runtime: { getURL: value => value } },
    crypto: { randomUUID: () => 'rpc-' + (++nextId) }, contract: Contract,
    compatibility: { BUILD_TARGET_VERSION: version } });
  const broker = Broker.create({
    callPageBridge: (method, params) => client.send(method, params,
      Contract.resolveDispatchPolicy(method, { writeback: 45, default: 8 })),
    sendBackgroundNative: async () => { throw new Error('No native asset reads expected'); },
    now: () => now, delay: async () => { now++; await tick(); },
    receiptTimeoutMs: 4, receiptPollMs: 1
  });
  return { journal, broker, calls, serverCalls, get executions() { return executions; },
    timeout() {
      const pending = [...timers.values()].find(timer => timer.ms === 45);
      assert.ok(pending, 'the real client must have its initial write timeout armed');
      pending.fn();
    }
  };
}
function report(operation, params) {
  const result = { ok: true, verifiedContent: '% QA\n',
    ...(operation.type === 'edit' ? { trackedChanges: [{ key: 'native:' + operation.path, path: operation.path }] } : {}) };
  params.onOperationResult({ operation, result });
  return { operation, result };
}
function success(applied) {
  return { ok: true, applied, skipped: [], trackedChanges: applied.flatMap(entry => entry.result.trackedChanges || []) };
}

test('a lost final reply is recovered without executing an already completed batch again', async () => {
  const h = harness(async (operations, params) => success(operations.map(operation => report(operation, params))),
    { dropApplyReply: true });
  const pending = h.broker.applyOperations({ operations: ops, runProjectId: 'project-a' });
  await tick(); h.timeout();
  const result = await pending;
  assert.equal(result.applied.length, 6);
  assert.equal(result.ok, true);
  assert.equal(h.executions, 1);
});

test('expired recovery retains confirmed writes, root error and uncertainty for the tail', async () => {
  const started = deferred(), release = deferred();
  const h = harness(async (operations, params) => {
    const applied = [report(operations[0], params)];
    started.resolve(); await release.promise;
    applied.push(...operations.slice(1).map(operation => report(operation, params)));
    return success(applied);
  });
  const pending = h.broker.applyOperations({ operations: ops, runProjectId: 'project-a' });
  await started.promise; h.timeout();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 5);
  assert.equal(result.code, 'page_bridge_timeout');
  assert.equal(result.receiptState, 'running');
  assert.ok(result.skipped.every(entry => entry.result.failure.changedDocument === true));
  assert.ok(result.skipped.every(entry => entry.result.failure.retryable === false));
  const blocked = await h.broker.applyOperations({ operations: [ops[0]], runProjectId: 'project-a' });
  assert.equal(blocked.code, 'writeback_in_progress');
  assert.equal(h.executions, 1, 'a new run must not overlap an unsettled page write');
  release.resolve(); await Promise.all(h.serverCalls);
});

test('missing or wrong-project receipts never cause replay or false success', async () => {
  for (const receiptResponse of [
    { ok: false, code: 'writeback_receipt_missing', error: 'missing' },
    { ok: true, requestId: 'foreign', runProjectId: 'other-project', state: 'completed', result: success([]) }
  ]) {
    const started = deferred(), release = deferred();
    const h = harness(async (operations, params) => {
      started.resolve(); await release.promise;
      return success(operations.map(operation => report(operation, params)));
    }, { receiptResponse });
    const pending = h.broker.applyOperations({ operations: ops, runProjectId: 'project-a' });
    await started.promise; h.timeout();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.skipped.length, 6);
    assert.equal(result.applied.length, 0);
    assert.equal(h.executions, 1);
    release.resolve(); await Promise.all(h.serverCalls);
  }
});
