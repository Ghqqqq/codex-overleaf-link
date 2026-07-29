const assert = require('node:assert/strict');
const test = require('node:test');
const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');

test('queued follow-ups preserve FIFO order and claim exactly one item', () => {
  let queue = [];
  queue = Queue.enqueue(queue, { id: 'a', text: 'first' }, { now: () => '2026-07-20T00:00:00.000Z' }).queue;
  queue = Queue.enqueue(queue, { id: 'b', text: 'second' }, { now: () => '2026-07-20T00:00:01.000Z' }).queue;
  const claimed = Queue.claimNext(queue, { randomUUID: () => 'claim-a' });
  assert.equal(claimed.item.id, 'a');
  assert.equal(claimed.queue[0].status, 'claimed');
  assert.equal(claimed.queue[1].status, 'queued');
});

test('reload recovery pauses claimed, executing, and steering inputs', () => {
  const queue = Queue.normalizeQueue([
    { id: 'a', text: 'one', status: 'claimed' },
    { id: 'b', text: 'two', status: 'executing' },
    { id: 'c', text: 'three', status: 'steering' }
  ], { recoverActive: true });
  assert.deepEqual(queue.map(item => item.status), ['paused', 'paused', 'paused']);
});

test('scheduler pauses all remaining work after abnormal settlement', async () => {
  let queue = [
    { id: 'a', text: 'one', status: 'executing' },
    { id: 'b', text: 'two', status: 'queued' }
  ];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {},
    isRunning: () => true
  });
  await scheduler.afterSettlement({ sessionId: 's', status: 'failed', queueItemId: 'a' });
  assert.deepEqual(queue.map(item => item.status), ['paused', 'paused']);
});

test('a queued input leaves the queue once its run record takes ownership', async () => {
  let queue = [
    { id: 'a', text: 'running now', status: 'claimed' },
    { id: 'b', text: 'still waiting', status: 'queued' }
  ];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {}
  });
  await scheduler.markExecuting('s', 'a', 'run-a');
  assert.deepEqual(queue.map(item => item.id), ['b']);
});

test('manual cancellation discards the interrupted queue item and starts the next follow-up', async () => {
  let queue = [
    { id: 'a', text: 'interrupted', status: 'executing' },
    { id: 'b', text: 'next', status: 'queued' }
  ];
  const started = [];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, next) => { queue = next; },
    persist: async () => {},
    isRunning: () => false,
    start: item => { started.push(item.id); }
  });
  await scheduler.afterSettlement({
    sessionId: 's',
    status: 'rejected',
    queueItemId: 'a',
    continueQueue: true
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['b']);
  assert.equal(queue[0].id, 'b');
  assert.equal(queue[0].status, 'claimed');
});

for (const settlement of [
  { name: 'completion', status: 'completed', continueQueue: false },
  { name: 'manual cancellation', status: 'rejected', continueQueue: true }
]) {
  test(`direct-run ${settlement.name} starts the first queued follow-up without pausing it`, async () => {
    let queue = [
      { id: 'b', text: 'next', status: 'queued' }
    ];
    const started = [];
    const scheduler = Scheduler.create({
      getQueue: () => queue,
      setQueue: (_sessionId, next) => { queue = next; },
      persist: async () => {},
      isRunning: () => false,
      start: item => { started.push(item.id); }
    });
    await scheduler.afterSettlement({
      sessionId: 's',
      status: settlement.status,
      queueItemId: '',
      continueQueue: settlement.continueQueue
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['b']);
    assert.equal(queue[0].id, 'b');
    assert.equal(queue[0].status, 'claimed');
  });
}

test('session state persists queued inputs and pauses active claims on reload', () => {
  const SessionState = require('../extension/src/shared/sessionState');
  const restored = SessionState.normalizePanelState({
    sessions: [{
      id: 'session-1',
      title: 'Queue',
      pendingInputs: [{ id: 'q1', text: 'continue', status: 'executing' }]
    }],
    activeSessionId: 'session-1'
  }, { restoreRunningRuns: true });
  assert.equal(restored.sessions[0].pendingInputs[0].status, 'paused');
  const compact = SessionState.prepareStateForStorage(restored);
  assert.equal(compact.sessions[0].pendingInputs[0].text, 'continue');
});
