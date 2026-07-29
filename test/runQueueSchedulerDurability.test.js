const assert = require('node:assert/strict');
const test = require('node:test');

const Scheduler = require('../extension/src/content/runQueueScheduler');

test('afterSettlement keeps the in-memory item when durable removal fails', async () => {
  const original = [{
    id: 'queue-1',
    text: 'continue',
    status: 'executing',
    claimToken: 'claim-1'
  }];
  let queue = structuredClone(original);
  let dequeued = 0;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {
      const error = new Error('storage unavailable');
      error.code = 'storage_unavailable';
      throw error;
    },
    onDequeued: () => { dequeued += 1; }
  });

  await assert.rejects(
    scheduler.afterSettlement({
      sessionId: 'session-1',
      status: 'completed',
      queueItemId: 'queue-1'
    }),
    /storage unavailable/
  );

  assert.deepEqual(queue, original);
  assert.equal(dequeued, 0);
});

test('afterSettlement includes the active claim token in durable removal', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'executing',
    claimToken: 'claim-1'
  }];
  let mutation = null;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async options => { mutation = options.queueMutation; }
  });

  await scheduler.afterSettlement({
    sessionId: 'session-1',
    status: 'completed',
    queueItemId: 'queue-1'
  });

  assert.equal(mutation.claimToken, 'claim-1');
  assert.deepEqual(queue, []);
});

test('afterSettlement preserves guidance enqueued while durable removal is pending', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'executing',
    claimToken: 'claim-1'
  }];
  let releasePersist;
  let signalPersist;
  const persistStarted = new Promise(resolve => { signalPersist = resolve; });
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {
      signalPersist();
      await new Promise(resolve => { releasePersist = resolve; });
    }
  });
  const pending = scheduler.afterSettlement({
    sessionId: 'session-1',
    status: 'completed',
    queueItemId: 'queue-1'
  });

  await persistStarted;
  queue = queue.concat({ id: 'queue-2', text: 'new guidance', status: 'queued' });
  releasePersist();
  await pending;

  assert.deepEqual(queue.map(item => item.id), ['queue-2']);
});

test('afterSettlement does not drop concurrent guidance when pause persistence fails', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'executing',
    claimToken: 'claim-1'
  }];
  let rejectPersist;
  let signalPersist;
  const persistStarted = new Promise(resolve => { signalPersist = resolve; });
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {
      signalPersist();
      await new Promise((_resolve, reject) => { rejectPersist = reject; });
    }
  });
  const pending = scheduler.afterSettlement({
    sessionId: 'session-1',
    status: 'failed'
  });

  await persistStarted;
  queue = queue.concat({ id: 'queue-2', text: 'new guidance', status: 'queued' });
  rejectPersist(new Error('storage unavailable'));
  await assert.rejects(pending, /storage unavailable/);

  assert.deepEqual(queue.map(item => item.id), ['queue-1', 'queue-2']);
});

test('execution promotion includes the active claim token in durable removal', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'claimed',
    claimToken: 'claim-1'
  }];
  let mutation = null;
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async options => { mutation = options.queueMutation; }
  });

  await scheduler.markExecuting('session-1', 'queue-1', 'run-1');

  assert.equal(mutation.type, 'remove');
  assert.equal(mutation.claimToken, 'claim-1');
  assert.deepEqual(queue, []);
});

test('execution promotion preserves guidance enqueued while persistence is pending', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'claimed',
    claimToken: 'claim-1'
  }];
  let releasePersist;
  let signalPersist;
  const persistStarted = new Promise(resolve => { signalPersist = resolve; });
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {
      signalPersist();
      await new Promise(resolve => { releasePersist = resolve; });
    }
  });
  const pending = scheduler.markExecuting('session-1', 'queue-1', 'run-1');

  await persistStarted;
  queue = queue.concat({ id: 'queue-2', text: 'new guidance', status: 'queued' });
  releasePersist();
  await pending;

  assert.deepEqual(queue.map(item => item.id), ['queue-2']);
});

test('failed execution promotion restores with the original claim token', async () => {
  let queue = [{
    id: 'queue-1',
    text: 'continue',
    status: 'claimed',
    claimToken: 'claim-1'
  }];
  const mutations = [];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async options => {
      mutations.push(options.queueMutation);
      if (mutations.length === 1) throw new Error('write failed');
    }
  });

  await assert.rejects(
    scheduler.markExecuting('session-1', 'queue-1', 'run-1'),
    /write failed/
  );

  assert.deepEqual(
    mutations.map(mutation => [mutation.type, mutation.claimToken]),
    [['remove', 'claim-1'], ['restore', 'claim-1']]
  );
});
