const assert = require('node:assert/strict');
const test = require('node:test');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');

test('active turn owner binds the native request and exposes journal recovery', async () => {
  const posted = [];
  const port = {
    postMessage(message) { posted.push(message); },
    disconnect() {},
    onDisconnect: { addListener() {} }
  };
  const runtimeMessages = [];
  const control = ActiveTurnControl.create({
    chrome: {
      runtime: {
        connect() { return port; },
        async sendMessage(message) {
          runtimeMessages.push(message);
          if (message.type === 'codex-overleaf/run-journal/list') {
            return { ok: true, journals: [{ requestId: 'run-1' }] };
          }
          return { ok: true };
        }
      }
    }
  });

  control.bind({
    requestId: 'run-1',
    projectKey: 'project-1',
    clientRunId: 'turn-1',
    sessionId: 'session-1'
  });
  assert.equal(posted[0].type, 'bind');
  assert.equal(posted[0].requestId, 'run-1');
  assert.equal((await control.listJournals('project-1'))[0].requestId, 'run-1');
  await control.acknowledge('run-1');
  assert.deepEqual(runtimeMessages.map(message => message.type), [
    'codex-overleaf/run-journal/list',
    'codex-overleaf/run-journal/ack'
  ]);
});

test('a running record whose Native journal disappeared after an extension reload settles as interrupted', async () => {
  const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const run = id => ({ id, status: 'running', nativeRequestId: 'req-' + id, startedAt, runProjectId: 'project-1', events: [] });
  const session = { id: 'session-1', projectId: 'project-1', codexThreadId: 'thread-1',
    runs: [run('orphan'), run('alive'), run('owned'), { ...run('fresh'), startedAt: new Date().toISOString() }] };
  const asked = [];
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    connect() { return { postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }; },
    async sendMessage(message) {
      if (message.type === 'codex-overleaf/run-journal/list') return { ok: true, journals: [] };
      if (message.type === 'codex-overleaf/run-journal/known') { asked.push(...message.requestIds); return { ok: true, known: ['req-alive'], ownersChecked: true }; }
      return { ok: true };
    }
  } } });
  const result = await control.recoverJournals({ projectKey: 'project-1', listSessions: () => [session],
    isLiveRun: record => record.id === 'owned',
    normalizeInterruptedRun: record => { record.events.push({ kind: 'report', title: 'stopped' }); } });
  assert.deepEqual(asked, ['req-orphan', 'req-alive']);
  assert.deepEqual(session.runs.map(item => item.status), ['interrupted', 'running', 'running', 'running']);
  assert.equal(session.runs[0].interruptedDraft.reason, 'extension_reloaded');
  assert.equal(session.runs[0].events.length, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(result.recoveredRuns.map(item => item.runId), ['orphan']);
});

test('an unreadable journal inventory never settles a running record', async () => {
  const session = { id: 's', projectId: 'p', runs: [{ id: 'r', status: 'running', nativeRequestId: 'q',
    startedAt: new Date(Date.now() - 600000).toISOString(), events: [] }] };
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    connect() { return { postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }; },
    async sendMessage(message) { return message.type === 'codex-overleaf/run-journal/known' ? { ok: false } : { ok: true, journals: [] }; }
  } } });
  const result = await control.recoverJournals({ projectKey: 'p', listSessions: () => [session] });
  assert.equal(session.runs[0].status, 'running');
  assert.equal(result.changed, false);
});


function recoveryHarness(t, age = 10000) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const record = { id: 'r', runProjectId: 'p', nativeRequestId: 'q', status: 'running',
    startedAt: new Date(Date.now() - age).toISOString(), events: [] };
  const session = { id: 's', projectId: 'p', runs: [record] };
  const requests = [];
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    connect() { return { postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }; },
    async sendMessage(message) { requests.push(message); return { ok: true, journals: [], known: [], ownersChecked: true }; }
  } } });
  t.after(() => control.destroy());
  const options = { projectKey: 'p', listSessions: () => [session] };
  const recover = () => control.recoverJournals({ ...options, onRecheck: recover });
  return { control, session, record, requests, options, recover };
}
const settlePromises = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('a young orphan is rechecked once when its grace expires without another page initialization', async t => {
  const h = recoveryHarness(t);
  await h.recover();
  t.mock.timers.tick(900); await h.recover();
  assert.equal(h.record.status, 'running');
  t.mock.timers.tick(49099); await settlePromises();
  assert.equal(h.record.status, 'running');
  t.mock.timers.tick(1); await settlePromises();
  assert.equal(h.record.status, 'interrupted');
  const calls = h.requests.length;
  t.mock.timers.tick(600000); await settlePromises();
  assert.equal(h.requests.length, calls, 'the deadline does not become a polling loop');
});

test('destroy and stale view guards prevent delayed recovery', async t => {
  const h = recoveryHarness(t);
  await h.recover(); h.control.destroy();
  t.mock.timers.tick(60000); await settlePromises();
  assert.equal(h.record.status, 'running');
});

test('a query result cannot interrupt a record that became live while inventory was pending', async () => {
  let resolve, live = false;
  const record = { id: 'r', nativeRequestId: 'q', status: 'running', startedAt: '2000-01-01', events: [] };
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    async sendMessage(message) { return message.type.endsWith('/known')
      ? new Promise(done => { resolve = done; }) : { ok: true, journals: [] }; }
  } } });
  const pending = control.recoverJournals({ projectKey: 'p', listSessions: () => [{ id: 's', runs: [record] }], isLiveRun: () => live });
  await settlePromises(); live = true; resolve({ ok: true, known: [], ownersChecked: true });
  assert.equal((await pending).changed, false); assert.equal(record.status, 'running'); control.destroy();
});


test('inventory batches more than 64 records and preserves a live request in the final batch', async () => {
  const runs = Array.from({ length: 70 }, (_, i) => ({ id: 'r' + i, nativeRequestId: 'q' + i, status: 'running', startedAt: '2000-01-01', events: [] }));
  const batches = [];
  const control = ActiveTurnControl.create({ chrome: { runtime: { async sendMessage(message) {
    if (!message.type.endsWith('/known')) return { ok: true, journals: [] };
    batches.push(message.requestIds.length);
    return { ok: true, ownersChecked: true, known: message.requestIds.slice(0, 64).filter(id => id === 'q69') };
  } } } });
  const result = await control.recoverJournals({ projectKey: 'p', listSessions: () => [{ id: 's', runs }] });
  assert.deepEqual(batches, [64, 6]);
  assert.equal(result.recoveredRuns.length, 69); assert.equal(runs[69].status, 'running'); control.destroy();
});

test('an older background without browser-owner inventory support cannot declare a run orphaned', async () => {
  const run = { id: 'r', nativeRequestId: 'q', status: 'running', startedAt: '2000-01-01', events: [] };
  const control = ActiveTurnControl.create({ chrome: { runtime: { async sendMessage() { return { ok: true, journals: [], known: [] }; } } } });
  assert.equal((await control.recoverJournals({ projectKey: 'p', listSessions: () => [{ id: 's', runs: [run] }] })).changed, false);
  assert.equal(run.status, 'running'); control.destroy();
});

test('a changed scope invalidates an outstanding inventory and its grace timer', async t => {
  const h = recoveryHarness(t);
  let current = true;
  h.options.isCurrent = () => current;
  await h.recover(); current = false;
  t.mock.timers.tick(60000); await settlePromises();
  assert.equal(h.record.status, 'running'); assert.equal(h.requests.length, 1);
});

test('replaced run objects are not mutated after a pending inventory response', async () => {
  let resolve;
  const record = { id: 'r', nativeRequestId: 'q', status: 'running', startedAt: '2000-01-01', events: [] };
  const session = { id: 's', runs: [record] };
  const control = ActiveTurnControl.create({ chrome: { runtime: { async sendMessage(message) {
    return message.type.endsWith('/known') ? new Promise(done => { resolve = done; }) : { ok: true, journals: [] };
  } } } });
  const pending = control.recoverJournals({ projectKey: 'p', listSessions: () => [session] });
  await settlePromises(); session.runs = [{ ...record, status: 'completed' }]; resolve({ ok: true, known: [], ownersChecked: true });
  assert.equal((await pending).changed, false); assert.equal(record.status, 'running'); assert.equal(session.runs[0].status, 'completed'); control.destroy();
});


test('unavailable page-owner probes retain running state with at most three delayed retries', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000 });
  const run = { id: 'r', nativeRequestId: 'q', status: 'running', startedAt: new Date(0).toISOString(), events: [] };
  let queries = 0;
  const control = ActiveTurnControl.create({ chrome: { runtime: { async sendMessage(message) {
    if (!message.type.endsWith('/known')) return { ok: true, journals: [] };
    queries++; return { ok: true, known: [], ownersChecked: false, retryAfterMs: 1000 };
  } } } });
  t.after(() => control.destroy());
  const recover = () => control.recoverJournals({ projectKey: 'p', listSessions: () => [{ id: 's', runs: [run] }], onRecheck: recover });
  await recover();
  for (let i = 0; i < 10; i++) { t.mock.timers.tick(1000); await settlePromises(); }
  assert.equal(queries, 4); assert.equal(run.status, 'running');
});
