'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'src', 'content', 'contentRuntime.js'),
  'utf8'
);

test('codex.run checks the current cancellation state before native dispatch', () => {
  const start = runtimeSource.indexOf('async function sendTrackedCodexRun(params)');
  const end = runtimeSource.indexOf('\n  async function', start + 1);
  const source = runtimeSource.slice(start, end);

  assert.ok(start >= 0, 'sendTrackedCodexRun should exist');
  assert.match(source, /throwIfRunCancellationRequested\(\);[\s\S]*sendNativeTracked\(/);
  assert.doesNotMatch(source, /throwIfCancelledBeforeNativeDispatch/);
});
