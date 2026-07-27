const assert = require('node:assert/strict');
const test = require('node:test');

const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');
const Snapshot = require('../extension/src/shared/runExecutionSnapshot');

function queuedItem() {
  return Queue.enqueue([], {
    text: 'continue',
    payload: Snapshot.toQueuePayload(Snapshot.capture({
      mode: 'ask',
      providerId: 'builtin',
      model: 'gpt'
    }))
  }, {
    randomUUID: () => 'queue-1',
    now: () => '2026-07-25T00:00:00.000Z'
  }).queue;
}

function settleMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

test('queue startup keeps claim, persist, start ordering', async () => {
  let queue = queuedItem();
  const order = [];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, value) => {
      queue = value;
      if (value[0]?.status === 'claimed') order.push('claim');
    },
    persist: async () => {
      order.push('persist');
    },
    start: async () => {
      order.push('start');
    },
    randomUUID: () => 'claim-1'
  });

  assert.equal(scheduler.scheduleOne('session-1'), true);
  await settleMicrotasks();
  assert.deepEqual(order, ['claim', 'persist', 'start']);
});

test('claim persistence failure pauses the queue, clears claim tokens, and never starts', async () => {
  let queue = queuedItem();
  let persistCalls = 0;
  let startCalls = 0;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, value) => {
      queue = value;
    },
    persist: async () => {
      persistCalls++;
      if (persistCalls === 1) {
        const error = new Error('quota');
        error.code = 'storage_quota_exceeded';
        throw error;
      }
    },
    start: async () => {
      startCalls++;
    },
    randomUUID: () => 'claim-1'
  });

  scheduler.scheduleOne('session-1');
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(startCalls, 0);
  assert.equal(queue[0].status, 'paused');
  assert.equal(queue[0].claimToken, '');
  assert.equal(queue[0].pauseReason, 'storage_quota_exceeded');
});

test('provider revision conflict pauses before persistence can start the run', async () => {
  const submitted = Snapshot.capture({
    providerId: 'custom-a',
    providerRevision: 1,
    model: 'model-a'
  }, { requireProviderRevision: true });
  let queue = Queue.enqueue([], {
    text: 'continue',
    payload: Snapshot.toQueuePayload(submitted)
  }, {
    randomUUID: () => 'queue-1',
    now: () => '2026-07-25T00:00:00.000Z'
  }).queue;
  let startCalls = 0;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, value) => {
      queue = value;
    },
    persist: async () => {},
    resolveExecutionSnapshot: snapshot => Snapshot.resolveForExecution(snapshot, {
      catalog: {
        activeProviderId: 'custom-a',
        providers: [
          { id: 'builtin', kind: 'builtin' },
          { id: 'custom-a', kind: 'custom', revision: 2, models: [{ id: 'model-a' }] }
        ]
      }
    }),
    start: async () => {
      startCalls++;
    },
    randomUUID: () => 'claim-1'
  });

  scheduler.scheduleOne('session-1');
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(startCalls, 0);
  assert.equal(queue[0].status, 'paused');
  assert.equal(queue[0].pauseReason, 'provider_revision_conflict');
});

test('failed execution promotion restores the claimed input without dequeuing guidance', async () => {
  let queue = Queue.claimNext(queuedItem(), {
    randomUUID: () => 'claim-1'
  }).queue;
  const mutations = [];
  let dequeued = 0;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, value) => {
      queue = value;
    },
    persist: async input => {
      mutations.push(input.queueMutation.type);
      if (mutations.length === 1) {
        const error = new Error('session write failed');
        error.code = 'storage_write_failed';
        throw error;
      }
    },
    onDequeued: () => {
      dequeued++;
    }
  });

  await assert.rejects(
    scheduler.markExecuting('session-1', 'queue-1', 'run-1'),
    /session write failed/
  );
  assert.deepEqual(mutations, ['remove', 'restore']);
  assert.equal(dequeued, 0);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'paused');
  assert.equal(queue[0].claimToken, '');
  assert.equal(queue[0].pauseReason, 'storage_write_failed');
});
