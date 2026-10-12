const assert = require('node:assert/strict');
const test = require('node:test');
const ActiveTurnControl = require('../extension/src/content/activeTurnControl');


const settlePromises = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

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
