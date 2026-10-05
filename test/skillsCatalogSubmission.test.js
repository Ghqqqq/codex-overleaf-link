'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { harness, deferred } = require('./_helpers/runSubmissionHarness');
const { extractFunction } = require('./_helpers/extractFunction');
const { runCodexSession } = require('../native-host/src/codexSessionRunner');
const RunExecutionSnapshot = require('../extension/src/shared/runExecutionSnapshot');
const runtime = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
const catalog = [{ id: 'annotated-rewrite', name: 'Annotated Rewrite' }, { id: 'parallel-subagents', name: 'Parallel Subagents' }];
const flush = () => new Promise(resolve => setImmediate(resolve));

function skillsHarness({ enabled = true, cached = false, disabled = false } = {}) {
  const h = harness(), response = deferred();
  h.context.state.codexOverleafSkills = cached ? catalog : [];
  h.context.state.codexOverleafSkillEnabled = disabled ? { 'parallel-subagents': false } : {};
  h.context.getSkillLoadingSettings = () => ({ loadCodexLocalSkills: false, loadCodexOverleafSkills: enabled });
  h.context.getCodexOverleafSkillEnabled = () => h.context.state.codexOverleafSkillEnabled;
  h.context.isCodexOverleafSkillEnabled = id => h.context.state.codexOverleafSkillEnabled[id] !== false;
  h.context.codexOverleafSkillsCatalogPromise = null;
  let calls = 0;
  h.context.sendBackgroundNative = async request => {
    assert.equal(request.method, 'skills.list'); assert.equal(request.params.scope, 'codex-overleaf');
    calls += 1; return response.promise;
  };
  for (const name of ['primeCodexOverleafSkillsCatalog', 'getEnabledCodexOverleafSkillIds']) {
    vm.runInContext(extractFunction(runtime, name), h.context);
  }
  return { ...h, response, calls: () => calls,
    release(value = { ok: true, result: { skills: catalog } }) { response.resolve(value); } };
}

async function actualBrokerGate(t, params) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-native-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let ready = false;
  await runCodexSession({ params, rootDir: path.join(root, 'mirrors'),
    env: { HOME: root, USERPROFILE: root },
    executeCodex: async ({ workspacePath }) => {
      const file = path.join(workspacePath, '.codex-overleaf-subagents', 'broker.json');
      ready = fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).status === 'ready';
      return { assistantMessage: 'Synthetic run complete.' };
    }
  });
  return ready;
}

test('first submission waits for pending official skills and passes enabled IDs to the real Native broker gate', async t => {
  const h = skillsHarness();
  const prime = h.context.primeCodexOverleafSkillsCatalog();
  const run = h.start();
  try {
    await flush();
    assert.equal(h.io.requests.length, 0, 'unknown catalog cannot silently dispatch with empty enabled IDs');
    assert.equal(h.calls(), 1, 'panel prefetch and submission must share the outstanding read');
    h.release(); await prime; await run;
    assert.equal(h.io.errors.length, 0);
    assert.deepEqual(h.io.requests[0].enabledCodexOverleafSkillIds, ['annotated-rewrite', 'parallel-subagents']);
    assert.equal(await actualBrokerGate(t, h.io.requests[0]), true);
  } finally { h.release(); await prime; await run; }
});

test('skill preparation preserves submitted enable choices across later preference changes', async t => {
  const h = skillsHarness({ disabled: true });
  const prime = h.context.primeCodexOverleafSkillsCatalog();
  const run = h.start();
  h.context.state.codexOverleafSkillEnabled = {};
  h.release(); await prime; await run;
  assert.deepEqual(h.io.requests[0].enabledCodexOverleafSkillIds, ['annotated-rewrite']);
  assert.equal(await actualBrokerGate(t, h.io.requests[0]), false);
});

test('cached catalog preserves the normal broker route without another skills request', async t => {
  const h = skillsHarness({ cached: true });
  await h.start();
  assert.equal(h.calls(), 0); assert.equal(h.io.errors.length, 0);
  assert.equal(await actualBrokerGate(t, h.io.requests[0]), true);
});

test('disabled official skills do not wait for a catalog or activate the broker', async t => {
  const h = skillsHarness({ enabled: false });
  await h.start();
  assert.equal(h.calls(), 0); assert.equal(h.io.errors.length, 0);
  assert.equal(h.io.requests[0].loadCodexOverleafSkills, false);
  assert.equal(await actualBrokerGate(t, h.io.requests[0]), false);
});

test('failed required catalog preparation keeps the composer and avoids Native dispatch', async () => {
  const h = skillsHarness();
  const run = h.start();
  h.release({ ok: false, error: { message: 'Synthetic catalog unavailable' } });
  await run.catch(() => {}); await flush();
  assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
  assert.ok(h.io.errors.some(message => /catalog|skill/i.test(message)));
});

test('catalog wait retains the existing project ownership check before dispatch', async () => {
  const h = skillsHarness(), run = h.start();
  h.changeProject(); h.release();
  await assert.rejects(run, /active project changed/i);
  assert.equal(h.io.requests.length, 0);
  assert.equal(h.controls.get('[data-task]').value, 'task from A');
});

test('queued submission keeps its captured enabled IDs and does not inherit a later catalog', async t => {
  const h = skillsHarness({ cached: true });
  const queuedInput = { id: 'queued-a', text: 'Previously queued task', payload: {
    ...RunExecutionSnapshot.toQueuePayload(h.context.captureCurrentExecutionSnapshot()),
    submissionContext: { customInstructions: '', skillLoadingSettings: { loadCodexLocalSkills: false, loadCodexOverleafSkills: true },
      skillInvocation: null, enabledCodexOverleafSkillIds: [] }
  } };
  await h.context.runTask({ queuedInput });
  assert.equal(h.calls(), 0); assert.equal(h.io.errors.length, 0);
  assert.deepEqual(h.io.requests[0].enabledCodexOverleafSkillIds, []);
  assert.equal(await actualBrokerGate(t, h.io.requests[0]), false);
});

test('repeated clicks while the catalog is pending preserve one submitted run and a later draft', async () => {
  const h = skillsHarness(), run = h.start();
  h.type('Later draft'); h.context.safeRunTask();
  await flush();
  assert.equal(h.io.requests.length, 0); assert.equal(h.calls(), 1);
  h.release(); await run;
  assert.equal(h.io.requests.length, 1);
  assert.equal(h.io.requests[0].task, 'task from A');
  assert.equal(h.controls.get('[data-task]').value, 'Later draft');
});

test('failed shared prefetch remains retryable through the original task entry', async t => {
  const h = skillsHarness();
  const prime = h.context.primeCodexOverleafSkillsCatalog().catch(error => error);
  const run = h.start();
  h.release({ ok: false, error: 'Synthetic catalog failure' });
  await prime; await run.catch(() => {}); await flush();
  assert.equal(h.io.requests.length, 0);
  h.context.sendBackgroundNative = async () => ({ ok: true, result: { skills: catalog } });
  await h.start();
  assert.equal(h.io.requests.length, 1);
  assert.equal(await actualBrokerGate(t, h.io.requests[0]), true);
});
