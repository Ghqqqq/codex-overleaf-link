'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./_helpers/diagnosticsHarness');

async function finishNative(h, operation, healthy = true) {
  h.resolve(operation.nativeIndex, healthy);
  await operation.promise;
  return h.snapshot();
}

test('one run-all keeps all four collected checks and updates the health dot', async () => {
  const h = harness();
  try {
    const operation = await h.start();
    assert.equal(h.snapshot().status, 'running');
    const result = await finishNative(h, operation);
    assert.equal(result.hidden, false); assert.equal(result.health, 'ok');
    assert.equal(result.rows.length, 4);
    assert.ok(result.rows.every(row => row.status === 'ok'));
    assert.equal(h.requests.length, 2);
  } finally { h.destroy(); }
});

test('closing without a replacement keeps the result hidden while the current full check updates health', async () => {
  const h = harness();
  try {
    const operation = await h.start(); h.close();
    const result = await finishNative(h, operation, false);
    assert.equal(result.hidden, true); assert.equal(result.dismissed, true);
    assert.equal(result.health, 'fail'); assert.equal(result.rows.length, 0);
  } finally { h.destroy(); }
});

for (const [oldHealthy, newHealthy] of [[false, true], [true, false]]) {
  test(`new full-check result and health survive the late ${oldHealthy ? 'successful' : 'failed'} older check`, async () => {
    const h = harness();
    try {
      const old = await h.start(); h.close();
      const current = await h.start();
      const result = await finishNative(h, current, newHealthy);
      assert.equal(result.status, newHealthy ? 'completed' : 'failed');
      assert.equal(result.health, newHealthy ? 'ok' : 'fail');
      await finishNative(h, old, oldHealthy);
      assert.deepEqual(h.snapshot(), result, 'stale completion must not replace rendered rows, text or health');
    } finally { h.destroy(); }
  });
}

test('a newer single check supersedes an older full check, including its health update', async () => {
  const h = harness();
  try {
    const old = await h.start(); h.close();
    const current = await h.start('native');
    const result = await finishNative(h, current);
    assert.equal(result.title, 'Local Connection OK'); assert.equal(result.rows.length, 0);
    assert.equal(result.health, 'unknown', 'single checks do not publish aggregate health');
    await finishNative(h, old, false);
    assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

test('a newer full check supersedes an older single Native check', async () => {
  const h = harness();
  try {
    const old = await h.start('native'); h.close();
    const current = await h.start();
    const result = await finishNative(h, current);
    await finishNative(h, old, false);
    assert.equal(result.rows.length, 4); assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

test('late failed page check cannot replace a newer successful project-read check', async () => {
  const h = harness();
  const gate = h.holdPage('probe');
  try {
    const old = await h.start('page'); h.close();
    const current = await h.start('snapshot'); await current.promise;
    const result = h.snapshot(); assert.equal(result.title, 'Project Read OK');
    gate.reject(new Error('synthetic delayed page failure')); await old.promise;
    assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

test('late project-read result cannot replace a newer page check', async () => {
  const h = harness();
  const gate = h.holdPage('getProjectSnapshot');
  try {
    const old = await h.start('snapshot'); h.close();
    const current = await h.start('page'); await current.promise;
    const result = h.snapshot(); assert.equal(result.title, 'Overleaf Page Ready');
    gate.resolve({ files: [], capabilities: {} }); await old.promise;
    assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

test('late enabled-OT result cannot replace a newer local-connection check', async () => {
  const h = harness({ otEnabled: true });
  const gate = h.holdPage('getOtStatus');
  try {
    const old = await h.start('ot'); h.close();
    const current = await h.start('native'); const result = await finishNative(h, current);
    gate.resolve({ ok: false, status: 'unavailable' }); await old.promise;
    assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

test('a disabled-OT check also supersedes an older in-flight full check', async () => {
  const h = harness();
  try {
    const old = await h.start(); h.close();
    const current = await h.start('ot'); await current.promise;
    const result = h.snapshot(); assert.equal(result.status, 'completed');
    assert.match(result.bodyText, /OT Mirror is disabled/);
    await finishNative(h, old, false); assert.deepEqual(h.snapshot(), result);
  } finally { h.destroy(); }
});

for (const [kind, changes] of [
  ['account', { accountScopeId: 'next-account' }],
  ['project', { projectId: 'next-project' }],
  ['navigation generation', { generation: 2 }]
]) {
  test(`${kind} change invalidates the old full-check result and health without requiring a new click`, async () => {
    const h = harness();
    try {
      const old = await h.start(); h.changeScope(changes);
      const before = h.snapshot(); await finishNative(h, old, false);
      assert.deepEqual(h.snapshot(), before);
    } finally { h.destroy(); }
  });
}

test('a single check from an earlier scope cannot publish after navigation away and back', async () => {
  const h = harness(); const gate = h.holdPage('getProjectSnapshot');
  try {
    const old = await h.start('snapshot');
    h.changeScope({ projectId: 'another-project', generation: 2 });
    h.changeScope({ projectId: 'synthetic-project', generation: 3 });
    const before = h.snapshot(); gate.resolve({ files: [], capabilities: {} }); await old.promise;
    assert.deepEqual(h.snapshot(), before);
  } finally { h.destroy(); }
});

for (const kind of ['native', 'page', 'snapshot', 'ot']) {
  test(`normal ${kind} check remains available through its production menu callback`, async () => {
    const h = harness();
    try {
      const operation = await h.start(kind);
      if (kind === 'native') await finishNative(h, operation);
      else await operation.promise;
      const result = h.snapshot();
      assert.equal(result.hidden, false); assert.equal(result.status, 'completed');
      assert.equal(result.rows.length, 0); assert.equal(result.health, 'unknown');
    } finally { h.destroy(); }
  });
}

test('enabled OT still renders a current healthy check', async () => {
  const h = harness({ otEnabled: true });
  try {
    const operation = await h.start('ot'); await operation.promise;
    assert.equal(h.snapshot().status, 'completed');
    assert.equal(h.snapshot().hidden, false);
    assert.ok(h.trace.some(item => item.method === 'getOtStatus'));
  } finally { h.destroy(); }
});

test('runtime scope dependencies are read only when a diagnostic starts, after controller construction', async () => {
  let initialized = false, reads = 0;
  const h = harness({ onScopeRead() { assert.equal(initialized, true); reads++; } });
  try {
    assert.equal(reads, 0, 'create must not evaluate late-initialized runtime scope variables');
    initialized = true;
    const operation = await h.start(); await finishNative(h, operation);
    assert.ok(reads > 0); assert.equal(h.snapshot().health, 'ok');
  } finally { h.destroy(); }
});
