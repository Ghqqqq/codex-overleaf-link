const assert = require('node:assert/strict');
const test = require('node:test');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');

test('a retained cancelled run does not cancel session catalogs or bypass request ownership guards', async () => {
  const NativeCompatibility = require('../extension/src/content/nativeCompatibilityController');
  let cancelled = false;
  let releasePing;
  const ping = new Promise(resolve => { releasePing = resolve; });
  const sent = [];
  const assertRunCurrent = () => {
    if (cancelled) throw Object.assign(new Error('Run cancelled'), { code: 'codex_cancelled' });
  };
  const controller = NativeCompatibility.create({
    gatedMethods: new Set(['codex.models', 'codex.providers.list', 'mirror.sync']),
    throwIfCancellationRequested: assertRunCurrent,
    fallbackNativeCompatibility: () => ({ status: 'ok' }),
    nativeChannel: { async sendBackgroundNative(payload) {
      if (payload.method === 'bridge.ping') return ping;
      sent.push(payload.method);
      return { ok: true, result: { method: payload.method } };
    } }
  });
  const models = controller.sendBackgroundNative({ method: 'codex.models' });
  const providers = controller.sendBackgroundNative({ method: 'codex.providers.list' });
  const mirror = controller.sendBackgroundNative({ method: 'mirror.sync' });
  const ownedCatalog = controller.sendBackgroundNative({ method: 'codex.models' }, { assertCurrent: assertRunCurrent });
  const mirrorRejected = assert.rejects(mirror, { code: 'codex_cancelled' });
  const ownedRejected = assert.rejects(ownedCatalog, { code: 'codex_cancelled', requestDispatched: false });
  cancelled = true;
  releasePing({ ok: true });
  assert.equal((await models).ok, true);
  assert.equal((await providers).ok, true);
  await mirrorRejected;
  await ownedRejected;
  assert.deepEqual(sent.sort(), ['codex.models', 'codex.providers.list']);
});

test('a stale cancellation cannot abort a different Native run, while explicit recovery can', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const filename = path.join(__dirname, '../native-host/src/taskRunnerRuntime.js');
  const nativeRequire = require('node:module').createRequire(filename);
  let signal, finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const stubs = {
    './codexRuntimeIdentity': { buildCodexRuntimeEvent: () => null },
    './nativeEnvironment': { refreshCodexRuntimeEnv: env => env },
    './providerRuntime': { isProviderMethod: () => false, resolveRunProviderForRun: async () => ({}) },
    './processStopBarrier': { isBlocked: () => false },
    './nativeRunLifecycle': { register: () => ({ complete() {}, trackProcess() {} }) },
    './debugLog': { logDebug() {}, truncateText: value => value },
    './codexSessionRunner': { async runCodexSession(input) {
      signal = input.signal;
      await stopped;
      signal.throwIfAborted();
      return { syncChanges: [] };
    } }
  };
  // Execute the public dispatcher and real admission/index cleanup; only
  // process, Provider and filesystem-facing lifecycle dependencies are replaced.
  const context = { module: { exports: {} }, AbortController, process: { env: {} },
    require: name => stubs[name] || nativeRequire(name) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const { handleRequest } = context.module.exports;
  const running = handleRequest({ id: 0, method: 'codex.run',
    params: { projectId: 'project', operation: 'compact', threadId: 'thread' } }, {});
  try {
    await settlePromises();
    assert.ok(signal);
    for (const requestId of ['old-run', '']) {
      const response = await handleRequest({ id: 'cancel', method: 'codex.cancel',
        params: { requestId, projectKey: 'project' } }, {});
      assert.equal(response.result.cancelled, false);
      assert.equal(response.result.reason, 'request_not_active');
      assert.equal(signal.aborted, false);
    }
    const recovery = await handleRequest({ id: 'recover', method: 'codex.cancel',
      params: { requestId: 'old-run', projectKey: 'project', force: true } }, {});
    assert.equal(recovery.result.cancelled, true);
    assert.equal(recovery.result.requestId, 0);
    assert.equal(signal.aborted, true);
  } finally {
    finish();
    await running;
  }
  const settled = await handleRequest({ id: 'late', method: 'codex.cancel',
    params: { requestId: 0, projectKey: 'project' } }, {});
  assert.equal(settled.result.cancelled, false);
});

test('cancellation in an inactive session persists a paused queue without starting its next task', async () => {
  const Queue = require('../extension/src/shared/runInputQueue');
  const Scheduler = require('../extension/src/content/runQueueScheduler');
  let queue = Queue.enqueue([], { text: 'Keep the follow-up', payload: {} }, { randomUUID: () => 'queued' }).queue;
  let starts = 0;
  const saves = [];
  const scheduler = Scheduler.create({
    getQueue: () => queue,
    setQueue: (_sessionId, value) => { queue = value; },
    canStart: () => false,
    isRunning: () => false,
    persist: async mutation => { saves.push({ mutation, queue: JSON.parse(JSON.stringify(queue)) }); },
    start: () => { starts++; }
  });
  await scheduler.afterSettlement({ sessionId: 'original-session', status: 'cancelled', continueQueue: true });
  await settlePromises();
  assert.equal(starts, 0);
  assert.equal(queue[0].status, 'paused');
  assert.equal(queue[0].pauseReason, 'session_inactive');
  assert.deepEqual(saves[0].mutation.queueMutation, { type: 'transition', sessionId: 'original-session' });
  const restored = Queue.normalizeQueue(saves[0].queue);
  assert.equal(restored[0].text, 'Keep the follow-up');
  assert.equal(restored[0].status, 'paused');
});


const settlePromises = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('ownerless startup and Native runs recover while live owners and fresh starts remain running', async () => {
  const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const run = id => ({ id, status: 'running', nativeRequestId: 'req-' + id, startedAt, runProjectId: 'project-1', events: [] });
  const session = { id: 'session-1', projectId: 'project-1', codexThreadId: 'thread-1',
    runs: [run('orphan'), run('alive'), run('owned'), { ...run('fresh'), startedAt: new Date().toISOString() },
      { ...run('startup-orphan'), nativeRequestId: '' }, { ...run('startup-alive'), nativeRequestId: '' }] };
  const startupId = id => ActiveTurnControl.getStartupRequestId(session.id, id);
  const asked = [];
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    connect() { return { postMessage() {}, disconnect() {}, onDisconnect: { addListener() {} } }; },
    async sendMessage(message) {
      if (message.type === 'codex-overleaf/run-journal/list') return { ok: true, journals: [] };
      if (message.type === 'codex-overleaf/run-journal/known') {
        asked.push(...message.requestIds);
        assert.equal(message.owners.find(owner => owner.clientRunId === 'startup-orphan').preDispatch, true);
        return { ok: true, known: ['req-alive', startupId('startup-alive')], ownersChecked: true, preDispatchChecked: true };
      }
      return { ok: true };
    }
  } } });
  const result = await control.recoverJournals({ projectKey: 'project-1', listSessions: () => [session],
    isLiveRun: record => record.id === 'owned',
    normalizeInterruptedRun: record => { record.events.push({ kind: 'report', title: 'stopped' }); } });
  assert.deepEqual(asked, ['req-orphan', 'req-alive', startupId('startup-orphan'), startupId('startup-alive')]);
  assert.deepEqual(session.runs.map(item => item.status), ['interrupted', 'running', 'running', 'running', 'interrupted', 'running']);
  assert.equal(session.runs[0].interruptedDraft.reason, 'extension_reloaded');
  assert.equal(session.runs[0].events.length, 1);
  assert.equal(result.changed, true);
  assert.deepEqual(result.recoveredRuns.map(item => item.runId), ['orphan', 'startup-orphan']);
  assert.equal(session.runs[4].nativeRequestId, '');
  control.destroy();
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
  control.destroy();
});

test('older inventory responses cannot declare a startup owner absent', async () => {
  const record = { id: 'r', status: 'running', nativeRequestId: '', startedAt: '2000-01-01', events: [] };
  const control = ActiveTurnControl.create({ chrome: { runtime: {
    async sendMessage(message) { return message.type.endsWith('/known')
      ? { ok: true, known: [], ownersChecked: true } : { ok: true, journals: [] }; }
  } } });
  const result = await control.recoverJournals({ projectKey: 'p', listSessions: () => [{ id: 's', runs: [record] }] });
  assert.equal(result.changed, false); assert.equal(record.status, 'running'); control.destroy();
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

test('background startup inventory protects live owners across dispatch and worker restart', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  let receive, connect, probeCount = 0;
  const sender = { tab: { id: 1, url: 'https://www.overleaf.com/project/p' } };
  let health = { ok: true, runOwnerProtocol: 2, runOwners: [] };
  const context = {
    URL, console, setTimeout, clearTimeout,
    chrome: {
      runtime: { getManifest: () => ({ background: { service_worker: 'src/background.js' } }),
        onMessage: { addListener: listener => { receive = listener; } },
        onConnect: { addListener: listener => { connect = listener; } } },
      storage: { session: { get: async () => ({}) } },
      tabs: { query: async () => [sender.tab], sendMessage: async () => { probeCount++; return health; } }
    },
    // These services own unrelated message families; the owner transport and
    // inventory below execute through the production background entry point.
    CodexOverleafCompatibility: {}, CodexOverleafManagedUpdateProjection: {}, CodexOverleafNativeRequestIdentity: {},
    CodexOverleafGlobalPreferences: { installBackground() {} }, CodexOverleafStorageRunActions: {}, CodexOverleafSharedSessionTransfer: {},
    CodexOverleafSharedSessionsBackground: { installBackground() {} }, CodexOverleafUpdateRuntimeIdentity: {},
    CodexOverleafBootstrapMigration: {}, CodexOverleafBackgroundUpdateSafety: { create: () => ({}) },
    CodexOverleafUpdateConsent: {}, CodexOverleafUpdateRevocation: {}, CodexOverleafUpdateCoordinator: { init() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8'), context);
  const owner = { requestId: ActiveTurnControl.getStartupRequestId('s', 'r'), projectKey: 'p', sessionId: 's', clientRunId: 'r', preDispatch: true };
  const query = candidate => new Promise(resolve => receive({ type: 'codex-overleaf/run-journal/known',
    requestIds: [candidate.requestId], owners: [candidate] }, sender, resolve));
  let onPortMessage;
  const replies = [];
  connect({ name: 'codex-overleaf/run-owner', sender,
    onMessage: { addListener: listener => { onPortMessage = listener; } },
    onDisconnect: { addListener() {} }, postMessage: message => replies.push(message) });
  const binding = { ...owner, type: 'bind', browserOnly: true, ownerToken: 'owner-token' };
  onPortMessage(binding);
  assert.equal(replies.at(-1).type, 'bound');
  assert.equal((await query(owner)).known.includes(owner.requestId), true);
  assert.equal(probeCount, 0);

  // The session snapshot can still have no Native id after its owner dispatched.
  const nativeBinding = { ...binding, requestId: 'native-request', browserOnly: false };
  onPortMessage(nativeBinding);
  assert.equal((await query(owner)).known.includes(owner.requestId), true);
  onPortMessage({ ...nativeBinding, type: 'release' });
  health.runOwners = [nativeBinding]; // A restarted worker lost its port map.
  assert.equal((await query(owner)).known.includes(owner.requestId), true);
  assert.ok(probeCount > 0);

  health.runOwners = [{ ...nativeBinding, sessionId: 'different-session' }];
  const absent = await query(owner);
  assert.equal(absent.known.length, 0); assert.equal(absent.preDispatchChecked, true);
  health = { ok: true, runOwnerProtocol: 1, runOwners: [] };
  assert.equal((await query(owner)).ownersChecked, false);
  health.runOwners = [nativeBinding];
  const nativeOwner = { ...owner, preDispatch: false, requestId: nativeBinding.requestId };
  assert.equal((await query(nativeOwner)).known.includes(nativeOwner.requestId), true);
});
