'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Results = require('../extension/src/content/runResultActions').create();
const options = { tx: en => en, trackedChangeInFlight: new Map(),
  isTrackedChangeLifecycleRun: run => Boolean(run.trackedChangeStatus),
  projectRunSettlement: () => ({ canUndo: true }) };

test('completion metadata follows Undo and removes obsolete save state without rewriting the recorded answer', () => {
  const meta = [{ key: 'undo', label: 'Undo', value: '1 reversible write' },
    { key: 'saveState', label: 'Save', value: 'unconfirmed' }];
  const before = JSON.stringify(meta);
  const result = Results.projectCompletionMeta(meta, {
    id: 'run', undoStatus: 'applied', saveConfirmedAt: '2026-09-29T00:00:00Z'
  }, options);
  assert.match(result[0].value, /have been undone/);
  assert.equal(result.some(row => row.key === 'saveState'), false);
  assert.equal(JSON.stringify(meta), before);
});

test('accepted, partial and in-flight undo metadata retain their distinct lifecycle meanings', () => {
  const meta = [{ key: 'undo', label: 'Undo', value: 'old' }];
  assert.match(Results.projectCompletionMeta(meta, { id: 'run', trackedChangeStatus: 'accepted' }, options)[0].value, /no longer available/);
  assert.match(Results.projectCompletionMeta(meta, { id: 'run', undoStatus: 'partial' }, options)[0].value, /remaining changes/);
  const running = { ...options, trackedChangeInFlight: new Map([['run', 'reject']]) };
  assert.match(Results.projectCompletionMeta(meta, { id: 'run' }, running)[0].value, /Undoing/);
});

test('legacy flat reports retain multi-line prose and extract only standalone status rows', () => {
  const result = Results.splitFlatCompletionReport('Conclusion: kept.\nNext: prose.\n\nUndo: 1 write\n\nSave: unconfirmed');
  assert.equal(result.body, 'Conclusion: kept.\nNext: prose.');
  assert.deepEqual(result.meta.map(row => row.key), ['undo', 'saveState']);
});
