'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Queue = require('../extension/src/shared/runInputQueue');
const RunExecutionSnapshot = require('../extension/src/shared/runExecutionSnapshot');

test('legacy-admissible queues keep their count after execution snapshot dual-write', () => {
  const items = Array.from({ length: Queue.MAX_ITEMS }, (_, index) => ({
    id: `legacy-${index}`,
    clientUserMessageId: `legacy-${index}`,
    text: `task-${index}-${'x'.repeat(3600)}`,
    status: 'queued',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sourceRunId: '',
    linkedRunId: '',
    claimToken: '',
    pauseReason: '',
    payload: {
      mode: 'ask',
      providerId: 'builtin',
      providerRevision: '',
      model: 'gpt-5.6',
      reasoningEffort: 'high',
      speedTier: 'standard',
      autoRecompile: false,
      requireReviewing: false,
      focusFiles: ['main.tex']
    }
  }));

  assert.ok(Queue.estimateBytes(items) < Queue.MAX_QUEUE_BYTES);
  assert.equal(Queue.normalizeQueue(items).length, Queue.MAX_ITEMS);
});

test('storage compaction derives compatibility focus files from the canonical snapshot', () => {
  const snapshot = RunExecutionSnapshot.capture({
    task: 'Review the paper',
    mode: 'ask',
    providerId: 'builtin',
    model: 'gpt-5.6',
    reasoningEffort: 'high',
    speedTier: 'standard',
    focusFiles: ['sections/authoritative.tex']
  });
  const [compacted] = Queue.compactForStorage([{
    id: 'queued-1',
    clientUserMessageId: 'queued-1',
    text: 'Review the paper',
    status: 'queued',
    executionSnapshot: snapshot,
    payload: {
      ...RunExecutionSnapshot.toQueuePayload(snapshot),
      focusFiles: ['sections/stale.tex']
    }
  }]);

  assert.deepEqual(compacted.executionSnapshot.focusFiles, ['sections/authoritative.tex']);
  assert.deepEqual(compacted.payload.focusFiles, ['sections/authoritative.tex']);
});

test('starting a queued run validates its snapshot without rewriting future defaults', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const start = source.indexOf('applyQueuedInput: async item => {');
  const end = source.indexOf('run: item => runTask({ queuedInput: item })', start);
  const implementation = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(implementation, /resolveForExecution/);
  assert.doesNotMatch(implementation, /applyToState|updateActiveSession|applyStateToPanel/);
});
