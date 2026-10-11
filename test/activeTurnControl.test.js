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
      if (message.type === 'codex-overleaf/run-journal/known') { asked.push(...message.requestIds); return { ok: true, known: ['req-alive'] }; }
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
