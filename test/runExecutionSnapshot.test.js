const test = require('node:test');
const assert = require('node:assert/strict');

const Snapshot = require('../extension/src/shared/runExecutionSnapshot');
const Queue = require('../extension/src/shared/runInputQueue');

function customInput(overrides = {}) {
  return {
    mode: 'auto',
    providerId: 'provider-a',
    providerRevision: 7,
    model: 'model-a',
    reasoningEffort: 'high',
    speedTier: 'fast',
    autoRecompile: false,
    requireReviewing: true,
    focusFiles: ['main.tex', 'sections/intro.tex'],
    capturedAt: '2026-07-25T00:00:00.000Z',
    ...overrides
  };
}

test('new confirm snapshots are rejected while persisted confirm snapshots migrate to Ask', () => {
  assert.throws(
    () => Snapshot.create(customInput({ mode: 'confirm' })),
    error => error.code === 'suggest_mode_removed'
  );

  const restored = Snapshot.captureRawQueueTuple({
    executionSnapshot: customInput({ mode: 'confirm', source: 'submitted' })
  }, customInput());
  assert.equal(restored.mode, 'ask');
});

test('create captures one immutable, secret-free execution tuple', () => {
  const input = customInput();
  const snapshot = Snapshot.create(input);

  input.focusFiles.push('later.tex');
  assert.equal(snapshot.providerRevision, '7');
  assert.deepEqual(snapshot.focusFiles, ['main.tex', 'sections/intro.tex']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.focusFiles), true);
  assert.deepEqual(Snapshot.validate(snapshot), { ok: true, errors: [] });
});

test('captureRawQueueTuple preserves present empty values and infers only missing fields', () => {
  const raw = {
    payload: {
      mode: 'ask',
      providerId: 'provider-a',
      providerRevision: '',
      model: '',
      speedTier: 'standard',
      autoRecompile: true,
      requireReviewing: true,
      focusFiles: []
    }
  };
  const snapshot = Snapshot.captureRawQueueTuple(raw, customInput({
    providerRevision: 11,
    model: 'fallback-model',
    reasoningEffort: 'medium'
  }));

  assert.equal(snapshot.source, 'legacy-inferred');
  assert.equal(snapshot.providerRevision, '11');
  assert.equal(snapshot.model, '', 'a present empty model remains an exact baseline');
  assert.equal(snapshot.reasoningEffort, 'medium');
});

test('a complete legacy tuple is captured without consulting future defaults', () => {
  const snapshot = Snapshot.captureRawQueueTuple({
    payload: customInput({ providerRevision: '7' })
  }, customInput({
    providerId: 'provider-b',
    providerRevision: 99,
    model: 'future-model'
  }));

  assert.equal(snapshot.source, 'legacy-captured');
  assert.equal(snapshot.providerId, 'provider-a');
  assert.equal(snapshot.providerRevision, '7');
  assert.equal(snapshot.model, 'model-a');
});

test('persisted snapshots are authoritative and never re-inferred', () => {
  const original = Snapshot.create(customInput());
  const payload = Snapshot.toQueuePayload(original);
  const restored = Snapshot.captureRawQueueTuple(payload, customInput({
    providerId: 'provider-b',
    providerRevision: 3,
    model: 'model-b'
  }));

  assert.equal(Snapshot.equalsExecutionConfig(restored, original), true);
  assert.equal(restored.providerId, 'provider-a');
  assert.equal(restored.model, 'model-a');
});

test('custom provider edit and deletion fail closed at dispatch', () => {
  const snapshot = Snapshot.create(customInput());
  assert.throws(
    () => Snapshot.resolveForExecution(snapshot, {
      catalog: { providers: [{ id: 'provider-a', revision: 8 }] }
    }),
    error => error.code === 'provider_revision_conflict'
  );
  assert.throws(
    () => Snapshot.resolveForExecution(snapshot, { catalog: { providers: [] } }),
    error => error.code === 'provider_not_found'
  );
});

test('invalid revisions and secret-shaped fields cannot enter a snapshot', () => {
  assert.throws(
    () => Snapshot.capture(customInput({ providerRevision: 'latest' }), {
      requireProviderRevision: true
    }),
    error => error.code === 'provider_revision_conflict'
  );
  assert.throws(
    () => Snapshot.create({ ...customInput(), apiKey: 'secret' }),
    error => error.code === 'invalid_execution_snapshot'
  );
});

test('queue normalization preserves all legacy-admissible items despite snapshot dual-write overhead', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `item-${index}`,
    text: `follow up ${index}`,
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
    payload: customInput({
      focusFiles: Array.from({ length: 40 }, (__, fileIndex) =>
        `section-${index}/file-${fileIndex}.tex`
      )
    })
  }));

  assert.ok(Queue.estimateLegacyBytes(items) < Queue.MAX_QUEUE_BYTES);
  const normalized = Queue.normalizeQueue(items);
  assert.equal(normalized.length, 20);
  assert.ok(Queue.estimateBytes(normalized) < Queue.MAX_PERSISTED_QUEUE_BYTES);
  assert.ok(normalized.every(item =>
    item.executionSnapshot
    && Snapshot.equalsExecutionConfig(item.executionSnapshot, item.payload.executionSnapshot)
  ));
});

test('claimed queue items keep a cloned snapshot when project defaults change', () => {
  const queued = Queue.enqueue([], {
    id: 'queued-1',
    text: 'continue',
    payload: customInput()
  }, {
    now: () => '2026-07-25T00:00:00.000Z',
    randomUUID: () => 'queued-1'
  });
  const claimed = Queue.claimNext(queued.queue, {
    randomUUID: () => 'claim-1',
    resolveExecutionSnapshot: snapshot => Snapshot.resolveForExecution(snapshot, {
      catalog: { providers: [{ id: 'provider-a', revision: 7 }] }
    })
  });

  assert.equal(claimed.ok, true);
  assert.equal(claimed.item.executionSnapshot.providerId, 'provider-a');
  assert.equal(claimed.item.executionSnapshot.model, 'model-a');
  assert.notEqual(
    claimed.item.executionSnapshot,
    queued.queue[0].executionSnapshot,
    'claiming clones the immutable value instead of sharing queue state'
  );
});
