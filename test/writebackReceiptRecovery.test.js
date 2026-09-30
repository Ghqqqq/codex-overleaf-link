const test = require('node:test');
const assert = require('node:assert/strict');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const Broker = require('../extension/src/content/assetTransferBroker');
const Client = require('../extension/src/content/pageBridgeClient');
const Contract = require('../extension/src/shared/pageRpcContract');

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
            source: 'codex-overleaf/page', pageBridgeVersion: '2.4.1',
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
    compatibility: { BUILD_TARGET_VERSION: '2.4.1' } });
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

test('six writes survive the initial RPC timeout with receipts and no mutation replay', async () => {
  const started = deferred(), release = deferred();
  let firstPartial;
  const h = harness(async (operations, params) => {
    const applied = operations.slice(0, 3).map(operation => report(operation, params));
    started.resolve(); await release.promise;
    applied.push(...operations.slice(3).map(operation => report(operation, params)));
    return success(applied);
  }, { onReceipt: ({ journal, message }) => {
    firstPartial ||= journal.get(message.params);
    release.resolve();
  } });
  const pending = h.broker.applyOperations({ operations: ops, runProjectId: 'project-a', requireReviewing: true });
  await started.promise; h.timeout();
  const result = await pending;
  assert.equal(firstPartial.state, 'running');
  assert.equal(firstPartial.result.applied.length, 3);
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 6);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.trackedChanges.length, 2, 'keep mature Track recovery data');
  assert.equal(h.executions, 1);
  assert.equal(h.calls.filter(call => call.method === 'applyOperations').length, 1);
  assert.ok(h.calls.some(call => call.method === 'getWritebackReceipt'));
  assert.equal(result.receiptRecoveries[0].initialError, 'Page bridge timed out');
});

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
  assert.equal(result.error, 'Page bridge timed out');
  assert.equal(result.receiptState, 'running');
  assert.ok(result.skipped.every(entry => entry.result.failure.changedDocument === true));
  assert.ok(result.skipped.every(entry => entry.result.failure.retryable === false));
  const blocked = await h.broker.applyOperations({ operations: [ops[0]], runProjectId: 'project-a' });
  assert.equal(blocked.code, 'writeback_in_progress');
  assert.equal(h.executions, 1, 'a new run must not overlap an unsettled page write');
  release.resolve(); await Promise.all(h.serverCalls);
});

test('a dispatcher exception preserves earlier per-file receipts and its original error', async () => {
  const h = harness(async (operations, params) => {
    report(operations[0], params);
    throw new Error('upload confirmation failed');
  });
  const result = await h.broker.applyOperations({ operations: ops, runProjectId: 'project-a' });
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 1);
  assert.equal(result.skipped.length, 5);
  assert.equal(result.error, 'upload confirmation failed');
  assert.match(result.skipped[0].result.reason, /upload confirmation failed/);
  assert.equal(h.executions, 1);
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

test('unconfirmed text writes prevent dispatching later binary or text operations', async () => {
  const methods = [];
  const broker = Broker.create({
    callPageBridge: async method => {
      methods.push(method);
      if (method === 'applyOperations') return { ok: false, code: 'page_bridge_timeout', error: 'timeout', requestId: 'x' };
      if (method === 'getWritebackReceipt') return { ok: false, error: 'missing' };
      throw new Error('Later mutations must remain undispatched');
    }
  });
  const result = await broker.applyOperations({ runProjectId: 'project-a', operations: [
    ops[0], { type: 'binary-create', path: 'plot.png', contentBase64: 'AA==' }, ops[5]
  ] });
  assert.deepEqual(methods, ['applyOperations', 'getWritebackReceipt']);
  assert.equal(result.skipped.length, 3);
  assert.equal(result.skipped[1].result.changedDocument, false);
  assert.equal(result.skipped[2].result.changedDocument, false);
});

test('journal validates project identity, deduplicates delivery and preserves no-trace preparation', async () => {
  let calls = 0, preparations = 0, project = 'p';
  const journal = Journal.create({ getProjectId: () => project,
    prepareEditor: async () => { preparations++; return { ok: false, code: 'editing_not_confirmed' }; },
    applyOperations: async operations => { calls++; return success(operations.map(operation => ({ operation, result: { ok: true } }))); }
  });
  const params = { writebackRequestId: 'a', runProjectId: 'p', operations: [ops[0]] };
  assert.equal((await journal.apply({ ...params, runProjectId: 'other' })).ok, false);
  const first = await journal.apply(params), second = await journal.apply(params);
  assert.deepEqual(first, second); assert.equal(calls, 1);
  assert.equal((await journal.apply({ ...params, operations: [ops[1]] })).code, 'writeback_receipt_conflict');
  const noTrace = await journal.apply({ ...params, writebackRequestId: 'b', reviewingPolicy: 'no-trace-undo' });
  assert.equal(noTrace.skipped[0].result.code, 'editing_not_confirmed');
  assert.equal(preparations, 1); assert.equal(calls, 1);
  project = 'other';
  assert.equal(journal.get({ requestId: 'a', runProjectId: 'p' }).ok, false);
});

test('journal bounds completed receipt retention without expiring an active write', async () => {
  let now = 0;
  const gate = deferred();
  const journal = Journal.create({ getProjectId: () => 'p', now: () => now, retentionMs: 10, maxReceipts: 2,
    applyOperations: async operations => {
      if (operations[0]?.path === 'active') await gate.promise;
      return { ok: true, applied: [], skipped: [] };
    }
  });
  await journal.apply({ writebackRequestId: 'old', runProjectId: 'p', operations: [] });
  now = 20;
  const active = journal.apply({ writebackRequestId: 'active', runProjectId: 'p', operations: [{ path: 'active' }] });
  await tick(); now = 100;
  assert.equal(journal.get({ requestId: 'old', runProjectId: 'p' }).ok, false);
  assert.equal(journal.get({ requestId: 'active', runProjectId: 'p' }).state, 'running');
  gate.resolve(); await active;
});

test('broker merge retains top-level transport failures alongside existing review metadata', () => {
  const result = Broker.mergeApplyResults([
    { ok: true, ...success([{ operation: ops[0], result: { ok: true } }]) },
    { ok: false, code: 'page_bridge_timeout', error: 'Page bridge timed out', requestId: 'late' }
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Page bridge timed out');
  assert.equal(result.requestId, 'late');
  assert.equal(result.applied.length, 1);
});

test('receipt identity follows the existing hydrated editor authority and blocks later navigation', async () => {
  const WriteGuard = require('../extension/src/page/writeGuard');
  const window = { _ide: {} };
  const guard = WriteGuard.create({
    window, document: { querySelector: () => null },
    treeOperations: { getProjectId: () => 'stale-url-project' },
    sleep: async () => { window._ide.project = { _id: 'hydrated-project' }; }
  });
  const params = { writebackRequestId: 'hydrated', runProjectId: 'hydrated-project', operations: [ops[4]] };
  assert.equal(await guard.runWriteGuard(params), null);
  let writes = 0;
  const journal = Journal.create({
    getProjectId: expected => guard.getEditorProjectIdPageSide(expected),
    applyOperations: async operations => { writes++; return success(operations.map(operation => ({ operation, result: { ok: true } }))); }
  });
  assert.equal((await journal.apply(params)).ok, true);
  assert.equal(journal.get({ requestId: 'hydrated', runProjectId: 'hydrated-project' }).state, 'completed');
  assert.equal(writes, 1);
  window._ide.project._id = 'other-project';
  assert.equal(journal.get({ requestId: 'hydrated', runProjectId: 'hydrated-project' }).code, 'writeback_receipt_scope_changed');
});

test('journal forwards submitted Reviewing and Editing requirements without changing them', async () => {
  const received = [];
  const journal = Journal.create({ getProjectId: () => 'p',
    applyOperations: async (_operations, options) => { received.push(options); return success([]); }
  });
  for (const requireReviewing of [true, false]) await journal.apply({
    writebackRequestId: 'policy-' + requireReviewing, runProjectId: 'p',
    operations: [], requireReviewing, requireEditing: !requireReviewing
  });
  assert.deepEqual(received.map(value => [value.requireReviewing, value.requireEditing, value.runProjectId]),
    [[true, false, 'p'], [false, true, 'p']]);
});
