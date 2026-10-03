'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { harness } = require('./_helpers/undoRuntimeHarness');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/writebackOrchestrator.js'), 'utf8');

function setup(options = {}) {
  const h = harness({ mixed: true, failCheckpointPersistence: true });
  const calls = [];
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const orchestrator = context.window.CodexOverleafWritebackOrchestrator.create({
    getCurrentProjectId: () => h.state.projectId, tx: en => en,
    resetContextProject() {}, appendRunRecordEvent() {},
    callPageBridge: async method => { calls.push(method); },
    sendBackgroundNative: async request => {
      calls.push(request.method);
      if (options.gate) await options.gate;
      return { ok: true, result: { invalidated: true } };
    }
  });
  h.context.writebackOrchestrator = orchestrator;
  h.context.getPendingMirrorRefresh = orchestrator.getPendingMirrorRefresh;
  return { h, calls, orchestrator };
}

test('a failed mixed Undo checkpoint cannot skip invalidating already restored text', async () => {
  const { h, calls, orchestrator } = setup();
  const refs = structuredClone(h.run.undoTrackedChanges);
  await assert.rejects(h.undo(), /checkpoint persistence unavailable/);
  await orchestrator.getPendingMirrorRefresh();
  assert.equal(h.docs.get('main.tex').content, 'before\n');
  assert.equal(h.docs.has('qa/a.tex'), true);
  assert.equal(h.state.requests.some(request => request.method === 'applyOperations'), false);
  assert.equal(h.run.trackedChangeStatus, 'needs_review');
  assert.deepEqual(structuredClone(h.run.undoTrackedChanges), refs);
  assert.equal(h.context.trackedChangeInFlight.size, 0);
  assert.deepEqual(calls, ['mirror.invalidate', 'invalidateProjectSnapshot']);
});

test('the next Undo still waits for invalidation after a checkpoint failure', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, calls, orchestrator } = setup({ gate });
  await assert.rejects(h.undo(), /checkpoint persistence unavailable/);
  assert.ok(orchestrator.getPendingMirrorRefresh());
  const count = h.state.requests.length;
  const retry = h.undo();
  const rejected = assert.rejects(retry, /checkpoint persistence unavailable/);
  await Promise.resolve();
  assert.equal(h.state.requests.length, count);
  release();
  await rejected;
  await orchestrator.getPendingMirrorRefresh();
  assert.equal(calls.includes('mirror.invalidate'), true);
});

test('a rejected Page Undo with no changed-document evidence leaves the mirror untouched', async () => {
  const { h, calls, orchestrator } = setup();
  h.docs.get('main.tex').content = 'later collaborator rewrite\n';
  await assert.rejects(h.undo(), /checkpoint persistence unavailable/);
  await orchestrator.getPendingMirrorRefresh();
  assert.equal(h.docs.get('main.tex').content, 'later collaborator rewrite\n');
  assert.deepEqual(calls, []);
});

test('a thrown Page request releases the review lock without inventing an Undo result', async () => {
  const { h, calls } = setup();
  h.context.callPageBridge = async () => { throw new Error('synthetic bridge disconnected'); };
  await assert.rejects(h.undo(), /synthetic bridge disconnected/);
  assert.deepEqual(calls, []);
  assert.equal(h.context.trackedChangeInFlight.size, 0);
  assert.equal(h.docs.get('main.tex').content, 'before\n% mixed\n');
  assert.equal(h.docs.has('qa/a.tex'), true);
});
