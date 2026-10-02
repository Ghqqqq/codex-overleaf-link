const test = require('node:test');
const assert = require('node:assert/strict');
const Broker = require('../extension/src/content/assetTransferBroker');
const Client = require('../extension/src/content/pageBridgeClient');
const Journal = require('../extension/src/page/writebackReceiptJournal');
const Contract = require('../extension/src/shared/pageRpcContract');

const START = 1800000000000;
const deletes = ['qa/a.tex', 'qa/b.tex', 'qa.png'].map(path => ({
  type: 'delete', path, undoCreatedFile: { v: 1, path }
}));
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const success = applied => ({ ok: true, applied, skipped: [], trackedChanges: [] });

// Real RPC and Journal; only page mutation, time and transport faults are controlled.
function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  let project = 'qa-project', timerId = 0, rpcId = 0, receiptCount = 0;
  const timers = new Map(), listeners = new Set();
  const calls = [], dispatches = [], mutations = [], preparations = [], executions = [];
  const schedule = (fn, ms) => {
    const id = ++timerId;
    timers.set(id, { fn, at: Date.now() + ms });
    return id;
  };
  const pause = ms => new Promise(resolve => schedule(resolve, ms));
  const journal = Journal.create({
    getProjectId: () => project,
    now: () => Date.now(),
    prepareEditor: async params => {
      preparations.push(params);
      return options.prepareResult || { ok: true };
    },
    applyOperations: async (operations, params) => {
      executions.push(params);
      const applied = [], skipped = [];
      for (let i = 0; i < operations.length; i++) {
        mutations.push(operations[i]);
        const duration = options.durations?.[i] || 0;
        if (duration) await pause(duration);
        const result = options.operationResult?.(operations[i], i) || { ok: true };
        params.onOperationResult({ operation: operations[i], result });
        (result.ok ? applied : skipped).push({ operation: operations[i], result });
      }
      return { ...success(applied), ok: skipped.length === 0, skipped,
        ...(options.reviewingPolicyResult === undefined ? {} : { reviewingPolicy: options.reviewingPolicyResult }) };
    }
  });
  const window = {
    location: { origin: 'https://www.overleaf.com' },
    addEventListener(_name, fn) { listeners.add(fn); },
    removeEventListener(_name, fn) { listeners.delete(fn); },
    setTimeout: schedule,
    clearTimeout: id => timers.delete(id),
    queueMicrotask,
    postMessage(message) {
      dispatches.push(message);
      const deliver = result => {
        if (message.method === 'applyOperations' && options.dropApplyReply) return;
        for (const listener of [...listeners]) listener({
          source: window, origin: window.location.origin, data: {
            source: 'codex-overleaf/page', pageBridgeVersion: '2.5.0',
            pageBridgeRevision: Contract.REVISION, id: message.id, result
          }
        });
      };
      if (message.method === 'applyOperations') {
        journal.apply({ ...message.params, writebackRequestId: message.id }).then(deliver);
      } else if (message.method === 'getWritebackReceipt') {
        if (!options.dropReceiptReply) deliver(journal.get(message.params));
      } else {
        throw new Error('Unexpected RPC ' + message.method);
      }
    }
  };
  const client = Client.create({ window, document: {}, now: () => Date.now(),
    crypto: { randomUUID: () => 'undo-rpc-' + (++rpcId) },
    contract: Contract, compatibility: { BUILD_TARGET_VERSION: '2.5.0' } });
  const broker = Broker.create({
    now: () => Date.now(), delay: pause, receiptPollMs: 500,
    ...(options.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: options.receiptTimeoutMs }),
    sendBackgroundNative: async () => { throw new Error('Unexpected native asset request'); },
    callPageBridge: async (method, params) => {
      calls.push({ method, params, at: Date.now() });
      if (method === 'getWritebackReceipt' && options.onReceipt) {
        const replacement = await options.onReceipt({ index: ++receiptCount, params, journal,
          setProject: value => { project = value; } });
        if (replacement !== undefined) return replacement;
      }
      return client.send(method, params, Contract.resolveDispatchPolicy(method));
    }
  });
  async function advance(ms) {
    const target = Date.now() + ms;
    await drain();
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      t.mock.timers.setTime(next[1].at);
      next[1].fn();
      await drain();
    }
    t.mock.timers.setTime(target);
    await drain();
  }
  return { broker, journal, client, calls, dispatches, mutations, preparations, executions, advance };
}

function startUndo(h, options = {}) {
  return h.broker.applyOperations({ operations: deletes, runProjectId: 'qa-project',
    reviewingPolicy: 'no-trace-undo', requireEditing: true, deadlineAt: START + 90000, ...options });
}
const lookupCalls = h => h.calls.filter(call => call.method === 'getWritebackReceipt');
function assertSingleDispatch(h) {
  assert.equal(h.dispatches.filter(call => call.method === 'applyOperations').length, 1);
  const original = h.dispatches.find(call => call.method === 'applyOperations');
  for (const call of lookupCalls(h)) {
    assert.equal(call.params.requestId, original.id);
    assert.equal(call.params.runProjectId, 'qa-project');
  }
}

test('45s timeout retrieves the 60s Undo receipt without redispatch or duplicate deletion', async t => {
  const h = harness(t, { durations: [60000] });
  const work = startUndo(h);
  await h.advance(45000);
  assert.equal(lookupCalls(h).length, 1);
  assert.equal(h.mutations.length, 1);
  await h.advance(15000);
  const result = await work;
  assert.equal(result.ok, true);
  assert.equal(result.applied.length, 3);
  assert.deepEqual(h.mutations, deletes);
  assert.equal(result.receiptRecoveries[0].initialError, 'Page bridge timed out');
  assertSingleDispatch(h);
  assert.equal(h.preparations[0].reviewingPolicy, 'no-trace-undo');
  assert.equal(h.preparations[0].deadlineAt, START + 90000);
  assert.equal(h.executions[0].requireEditing, true);
  assert.ok(lookupCalls(h).every(call => call.params.deadlineAt === START + 90000));
});

test('an already expired deadline dispatches no delete or upload and marks every operation not started', async t => {
  const h = harness(t);
  const operations = [...deletes, { type: 'binary-create', path: 'never.png', contentBase64: 'eA==' }];
  const result = await startUndo(h, { operations, deadlineAt: START });
  assert.equal(h.calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'writeback_deadline_exceeded');
  assert.equal(result.receiptUnconfirmed, false);
  assert.equal(result.skipped.length, operations.length);
  assert.ok(result.skipped.every(entry => entry.result.changedDocument === false
    && /not dispatched/.test(entry.result.reason)));
});

test('the global deadline preserves partial evidence without restarting a 90s recovery budget', async t => {
  const h = harness(t, { durations: [30000, 30000] });
  const work = startUndo(h, { deadlineAt: START + 50000 });
  await h.advance(50000);
  const result = await work;
  assert.equal(Date.now(), START + 50000);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'page_bridge_timeout');
  assert.equal(result.error, 'Page bridge timed out');
  assert.equal(result.receiptState, 'running');
  assert.equal(result.receiptUnconfirmed, true);
  assert.deepEqual(result.applied.map(entry => entry.operation.path), ['qa/a.tex']);
  assert.deepEqual(result.skipped.map(entry => entry.operation.path), ['qa/b.tex', 'qa.png']);
  assert.ok(result.skipped.every(entry => entry.result.changedDocument === true));
  assert.ok(lookupCalls(h).every(call => call.at < START + 50000
    && call.params.deadlineAt === START + 50000));
  const count = h.calls.length;
  await h.advance(20000);
  assert.equal(h.calls.length, count);
  assertSingleDispatch(h);
});

test('an unconfirmed batch prevents later uploads and deletes from starting', async t => {
  const h = harness(t, { durations: [60000] });
  const operations = [deletes[0], { type: 'binary-create', path: 'never.png', contentBase64: 'eA==' }, deletes[1]];
  const work = startUndo(h, { operations, deadlineAt: START + 50000 });
  await h.advance(50000);
  const result = await work;
  assert.equal(result.receiptUnconfirmed, true);
  assert.equal(result.skipped[0].result.changedDocument, true);
  for (const entry of result.skipped.slice(1)) {
    assert.equal(entry.result.code, 'writeback_tail_not_started');
    assert.equal(entry.result.changedDocument, false);
  }
  assert.equal(h.mutations.length, 1);
  assert.ok(h.calls.every(call => ['applyOperations', 'getWritebackReceipt'].includes(call.method)));
  assertSingleDispatch(h);
});

test('a lost apply reply at the global deadline cannot start receipt polling', async t => {
  const h = harness(t, { dropApplyReply: true });
  const work = startUndo(h, { deadlineAt: START + 45000 });
  await h.advance(45000);
  const result = await work;
  assert.equal(result.ok, false);
  assert.equal(result.receiptUnconfirmed, true);
  assert.equal(lookupCalls(h).length, 0);
  assertSingleDispatch(h);
});

for (const fault of ['throw', 'timeout-result']) test(`temporary receipt ${fault} retries reads only`, async t => {
  const h = harness(t, { dropApplyReply: true, onReceipt: ({ index }) => {
    if (index <= 2) {
      if (fault === 'throw') throw Object.assign(new Error('Temporary transport failure'), { code: 'ECONNRESET' });
      return { ok: false, error: 'Page bridge timed out' };
    }
  } });
  const work = startUndo(h);
  await h.advance(46000);
  const result = await work;
  assert.equal(result.ok, true);
  assert.equal(lookupCalls(h).length, 3);
  assert.deepEqual(h.mutations, deletes);
  assertSingleDispatch(h);
});

test('temporary read failures preserve an earlier partial receipt until the deadline', async t => {
  const h = harness(t, { durations: [30000, 50000], onReceipt: ({ index }) => {
    if (index > 1) throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
  } });
  const work = startUndo(h, { deadlineAt: START + 46500 });
  await h.advance(46500);
  const result = await work;
  assert.equal(result.applied.length, 1);
  assert.equal(result.error, 'Page bridge timed out');
  assert.equal(result.recoveryError, 'Connection reset');
  assert.equal(lookupCalls(h).length, 3);
  assertSingleDispatch(h);
});

for (const code of ['writeback_receipt_missing', 'writeback_receipt_scope_changed', 'permission_denied']) {
  test(`${code} ends recovery immediately without another mutation`, async t => {
    const h = harness(t, { dropApplyReply: true, onReceipt: () => ({ ok: false, code, error: code }) });
    const work = startUndo(h);
    await h.advance(45000);
    const result = await work;
    assert.equal(result.ok, false);
    assert.equal(result.receiptUnconfirmed, true);
    assert.equal(result.error, 'Page bridge timed out');
    assert.equal(result.recoveryError, code);
    assert.equal(lookupCalls(h).length, 1);
    assertSingleDispatch(h);
  });
}

test('real Journal rejects a receipt after the active project changes', async t => {
  const h = harness(t, { dropApplyReply: true, onReceipt: ({ setProject }) => { setProject('other'); } });
  const work = startUndo(h);
  await h.advance(45000);
  const result = await work;
  assert.equal(result.ok, false);
  assert.match(result.recoveryError, /no longer active/);
  assert.equal(lookupCalls(h).length, 1);
  assertSingleDispatch(h);
});

for (const field of ['requestId', 'runProjectId']) test(`a mismatched ${field} cannot become Undo success`, async t => {
  const h = harness(t, { dropApplyReply: true, onReceipt: ({ params, journal }) => ({
    ...journal.get(params), [field]: 'other'
  }) });
  const work = startUndo(h);
  await h.advance(45000);
  const result = await work;
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 0);
  assert.match(result.recoveryError, /identity/);
  assert.equal(lookupCalls(h).length, 1);
  assertSingleDispatch(h);
});

test('no-trace Undo still requires the real Journal editor preparation guard', async t => {
  const h = harness(t, { prepareResult: { ok: false, code: 'editing_not_confirmed', changedDocument: false } });
  const result = await startUndo(h);
  assert.equal(result.ok, false);
  assert.equal(h.preparations.length, 1);
  assert.equal(h.mutations.length, 0);
  assert.equal(result.skipped.length, deletes.length);
  assert.ok(result.skipped.every(entry => entry.result.code === 'editing_not_confirmed'));
});

test('cancelling a real receipt RPC rejects Undo and never starts another dispatch', async t => {
  const h = harness(t, { durations: [60000], dropReceiptReply: true });
  const outcome = startUndo(h).then(result => ({ result }), error => ({ error }));
  await h.advance(45000);
  assert.equal(lookupCalls(h).length, 1);
  h.client.cancelActiveRequests();
  const settled = await outcome;
  assert.equal(settled.error?.code, 'codex_cancelled');
  assert.equal(settled.result, undefined);
  await h.advance(20000);
  assert.equal(lookupCalls(h).length, 1);
  assertSingleDispatch(h);
});

test('a cancellation result from the receipt boundary is also terminal', async t => {
  const h = harness(t, { dropApplyReply: true, onReceipt: () => ({
    ok: false, code: 'codex_cancelled', error: 'Cancelled'
  }) });
  const outcome = startUndo(h).then(result => ({ result }), error => ({ error }));
  await h.advance(45000);
  assert.equal((await outcome).error?.code, 'codex_cancelled');
  assert.equal(lookupCalls(h).length, 1);
  assertSingleDispatch(h);
});

test('ordinary writeback retains its recovery budget and Reviewing metadata without an absolute deadline', async t => {
  const reference = { key: 'main-review', path: 'main.tex' };
  const h = harness(t, { durations: [46000], operationResult: () => ({ ok: true, trackedChanges: [reference] }) });
  const operation = { type: 'edit', path: 'main.tex', patches: [] };
  const work = h.broker.applyOperations({ operations: [operation], runProjectId: 'qa-project', requireReviewing: true });
  await h.advance(46000);
  const result = await work;
  assert.equal(result.ok, true);
  assert.equal(h.preparations.length, 0);
  assert.equal(h.executions[0].requireReviewing, true);
  assert.equal(h.executions[0].requireEditing, false);
  assert.ok(h.calls.every(call => !Object.hasOwn(call.params, 'deadlineAt')));
  assert.equal(result.applied[0].result.trackedChanges[0].key, reference.key);
  assertSingleDispatch(h);
});

test('ordinary writeback honors the existing configured receipt budget', async t => {
  const h = harness(t, { durations: [60000], receiptTimeoutMs: 1000 });
  const work = h.broker.applyOperations({ operations: deletes, runProjectId: 'qa-project' });
  await h.advance(46000);
  const result = await work;
  assert.equal(result.ok, false);
  assert.equal(result.receiptUnconfirmed, true);
  assert.equal(lookupCalls(h).length, 3);
  assert.ok(h.calls.every(call => !Object.hasOwn(call.params, 'deadlineAt')));
  assertSingleDispatch(h);
});

test('a completed partial receipt keeps its original per-file failure and successful evidence', async t => {
  const failure = { code: 'server_content_mismatch', stage: 'undo_preimage', changedDocument: false };
  const h = harness(t, { dropApplyReply: true, operationResult: (_operation, index) => index === 1
    ? { ok: false, code: failure.code, changedDocument: false, failure } : { ok: true } });
  const work = startUndo(h);
  await h.advance(45000);
  const result = await work;
  assert.equal(result.ok, false);
  assert.equal(result.applied.length, 2);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0].result.failure, failure);
  assert.notEqual(result.receiptUnconfirmed, true);
  assertSingleDispatch(h);
});

test('a later unconfirmed result cannot be masked by an earlier known failure', () => {
  const merged = Broker.mergeApplyResults([
    { ok: false, applied: [], skipped: [], receiptUnconfirmed: false },
    { ok: false, applied: [], skipped: [], receiptUnconfirmed: true, code: 'page_bridge_timeout' }
  ]);
  assert.equal(merged.receiptUnconfirmed, true);
});

for (const value of [null, 0, -1, NaN, Infinity, '1800000100000']) {
  test(`invalid deadline ${String(value)} is rejected before dispatch`, async t => {
    const h = harness(t);
    const result = await startUndo(h, { deadlineAt: value });
    assert.equal(h.calls.length, 0);
    assert.equal(result.code, 'writeback_deadline_exceeded');
    assert.equal(result.receiptUnconfirmed, false);
    assert.ok(result.skipped.every(entry => entry.result.changedDocument === false));
  });
}

test('Undo receipt recovery preserves Reviewing policy metadata for the runtime event', async t => {
  const reviewingPolicy = { policy: 'no-trace-undo', editingConfirmed: true };
  const h = harness(t, { dropApplyReply: true, reviewingPolicyResult: reviewingPolicy });
  const work = startUndo(h, { deadlineAt: START + 120000 });
  await h.advance(45000);
  const result = await work;
  assert.equal(result.ok, true);
  assert.deepEqual(result.reviewingPolicy, reviewingPolicy);
  assert.ok(h.calls.every(call => call.params.deadlineAt === START + 120000));
  assertSingleDispatch(h);
});
