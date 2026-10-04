'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { refreshLab, session, remoteRun, State, RawDb } = require('./_helpers/sharedSessionRefreshHarness');
const { deferred, drain } = require('./_helpers/sharedSessionServiceHarness');

async function changeCompile(f) {
  const checkbox = f.h.controls.get('[data-auto-recompile]');
  checkbox.checked = !checkbox.checked;
  checkbox.matches = selector => selector === '[data-auto-recompile]';
  await f.h.context.persistPanelInputs({ type: 'change', target: checkbox });
}
function currentTask(f) { return f.h.context.state.task; }

test('normal passive refresh adopts remote history and permits the next explicit draft edit', async () => {
  const f = await refreshLab();
  try {
    await f.peerUpdate(); await f.clock.tick();
    await f.localSave();
    assert.equal(f.finalStored().task, 'observer edit after refresh');
    assert.equal(f.finalStored().title, 'Remote title');
    assert.deepEqual(f.finalStored().runs.map(run => run.id), ['remote-run']);
    assert.equal(f.commitResults[0].rebased, true); assert.equal(f.notices.length, 0);
  } finally { f.close(); }
});

for (const failurePoint of ['before-task', 'after-task']) test(`a ${failurePoint} render failure cannot let an unrelated control erase the remote draft`, async () => {
  const f = await refreshLab();
  try {
    const query = f.h.context.panel.querySelector, renderHistory = f.h.context.renderRunHistory;
    if (failurePoint === 'before-task') f.h.context.panel.querySelector = selector => selector === '[data-model]' ? null : query(selector);
    else f.h.context.renderRunHistory = () => { throw new Error('synthetic late DOM failure'); };
    await f.peerUpdate({ task: 'remote unsent draft' }); await f.clock.tick();
    assert.equal(currentTask(f), '', 'failed passive application must restore unedited prior memory');
    assert.equal(f.notices.length, 1);
    f.h.context.panel.querySelector = query; f.h.context.renderRunHistory = renderHistory;
    await changeCompile(f);
    assert.equal(f.finalStored().task, 'remote unsent draft');
    assert.equal(f.finalStored().title, 'Remote title');
    assert.deepEqual(f.finalStored().runs.map(run => run.id), ['remote-run']);
    const sent = f.network.messages.filter(e => e.sender.tab.id === 1 && e.message.method === 'put').at(-1);
    assert.equal(sent.message.entries[0].base.task, '', 'failed render must not adopt the remote baseline');
    assert.equal(f.commitResults[0].rebased, true);
    await f.clock.tick();
    assert.equal(currentTask(f), 'remote unsent draft');
    assert.equal(f.h.controls.get('[data-task]').value, 'remote unsent draft');
  } finally { f.close(); }
});

test('normalization failure preserves the old baseline and refuses a conflicting save without losing either view', async () => {
  const f = await refreshLab();
  try {
    const malformed = session({ title: 'Remote title', runs: [remoteRun], updatedAt: '2026-09-28T00:00:02.000Z' });
    malformed.runs[0].providerRevision = { valueOf: null, toString: null };
    assert.throws(() => RawDb.buildSessionRecord(malformed), /Cannot convert object to primitive value/);
    f.network.db.seed('sessions', { accountScopeId: 'account-one', projectId: 'project-one', id: 'A', record: malformed, revision: 2 });
    await f.network.notifyExternal(); await f.clock.tick();
    assert.equal(f.stateSummary().title, 'Original title');
    await assert.rejects(f.localSave(), { code: 'shared_session_conflict' });
    const saved = f.network.messages.filter(e => e.sender.tab.id === 1 && e.message.method === 'put').at(-1);
    assert.equal(saved.message.entries[0].base.title, 'Original title');
    assert.equal(f.finalStored().title, 'Remote title');
    assert.equal(f.finalStored().runs[0].id, 'remote-run');
    assert.equal(currentTask(f), 'observer edit after refresh');
  } finally { f.close(); }
});

test('one transient render failure retries successfully and later edits save normally', async () => {
  const f = await refreshLab();
  try {
    const query = f.h.context.panel.querySelector;
    f.h.context.panel.querySelector = selector => selector === '[data-model]' ? null : query(selector);
    await f.peerUpdate({ task: 'remote unsent draft' }); await f.clock.tick();
    assert.equal(f.clock.pending(), 1, 'one retry is scheduled');
    f.h.context.panel.querySelector = query; await f.clock.tick();
    assert.equal(currentTask(f), 'remote unsent draft');
    assert.equal(f.h.controls.get('[data-task]').value, 'remote unsent draft');
    await f.localSave(); assert.equal(f.finalStored().task, 'observer edit after refresh');
    assert.equal(f.clock.pending(), 0);
  } finally { f.close(); }
});

test('persistent failure exhausts its retry but a new notification can refresh after recovery', async () => {
  const f = await refreshLab();
  try {
    const query = f.h.context.panel.querySelector;
    f.h.context.panel.querySelector = selector => selector === '[data-model]' ? null : query(selector);
    await f.peerUpdate(); await f.clock.tick(); await f.clock.tick();
    assert.equal(f.clock.pending(), 0, 'a broken view cannot spin indefinitely');
    f.h.context.panel.querySelector = query;
    await f.network.notifyExternal(); await f.clock.tick();
    assert.equal(f.stateSummary().title, 'Remote title');
    await f.localSave(); assert.equal(f.finalStored().task, 'observer edit after refresh');
  } finally { f.close(); }
});

test('a local edit made before the retry is kept and a non-conflicting save still works', async () => {
  const f = await refreshLab();
  try {
    const query = f.h.context.panel.querySelector;
    f.h.context.panel.querySelector = selector => selector === '[data-model]' ? null : query(selector);
    await f.peerUpdate(); await f.clock.tick();
    f.h.context.panel.querySelector = query;
    f.h.type('new local draft'); await f.clock.tick();
    assert.equal(currentTask(f), 'new local draft');
    assert.equal(f.h.controls.get('[data-task]').value, 'new local draft');
    await f.h.context.saveState({ requireDurable: true });
    assert.equal(f.finalStored().task, 'new local draft');
    assert.equal(f.finalStored().title, 'Remote title');
  } finally { f.close(); }
});

test('synchronous local state edits during failed rendering are never overwritten by rollback', async () => {
  const f = await refreshLab();
  try {
    f.h.context.renderRunHistory = () => {
      f.h.context.state.task = 'in-place local edit';
      f.h.context.state.sessions.find(s => s.id === 'A').task = 'in-place local edit';
      throw new Error('synthetic DOM failure after synchronous edit');
    };
    await f.peerUpdate(); await f.clock.tick();
    assert.equal(currentTask(f), 'in-place local edit');
    assert.equal(f.h.context.state.sessions.find(s => s.id === 'A').task, 'in-place local edit');
    assert.equal(f.clock.pending(), 0, 'failure retry cannot overwrite a changed state');
  } finally { f.close(); }
});

test('synchronous identity change during failed rendering prevents rollback into the new view', async () => {
  const f = await refreshLab();
  try {
    f.h.context.renderRunHistory = () => {
      f.h.changeProject(); f.h.context.spaRouteGeneration++;
      f.h.context.state = State.normalizePanelState({ activeSessionId: 'new-view', sessions: [{ id: 'new-view', task: 'other project draft', runs: [] }] });
      throw new Error('synthetic DOM failure after navigation');
    };
    await f.peerUpdate(); await f.clock.tick();
    assert.equal(f.h.context.state.activeSessionId, 'new-view');
    assert.equal(currentTask(f), 'other project draft');
    assert.equal(f.clock.pending(), 0);
  } finally { f.close(); }
});

test('an edit made during the best-effort restoration survives its own render failure', async () => {
  const f = await refreshLab();
  try {
    let renderCalls = 0;
    f.h.context.renderRunHistory = () => {
      if (++renderCalls === 2) f.h.type('edit during restoration');
      throw new Error('synthetic repeated render failure');
    };
    await f.peerUpdate(); await f.clock.tick();
    assert.equal(renderCalls, 2);
    assert.equal(currentTask(f), 'edit during restoration');
    assert.equal(f.h.controls.get('[data-task]').value, 'edit during restoration');
    assert.equal(f.clock.pending(), 0);
  } finally { f.close(); }
});

test('an identity change during best-effort restoration is never replaced with the original view', async () => {
  const f = await refreshLab();
  try {
    let renderCalls = 0;
    f.h.context.renderRunHistory = () => {
      if (++renderCalls === 2) {
        f.h.changeAccount(); f.h.context.spaRouteGeneration++;
        f.h.context.state = State.normalizePanelState({ activeSessionId: 'other-account', sessions: [{ id: 'other-account', task: 'other account draft', runs: [] }] });
      }
      throw new Error('synthetic repeated render failure');
    };
    await f.peerUpdate(); await f.clock.tick();
    assert.equal(renderCalls, 2);
    assert.equal(f.h.context.state.activeSessionId, 'other-account');
    assert.equal(currentTask(f), 'other account draft'); assert.equal(f.clock.pending(), 0);
  } finally { f.close(); }
});

test('an awaited snapshot from the old scope cannot be adopted after navigation', async () => {
  const f = await refreshLab(), gate = deferred();
  try {
    const read = f.observerDb.readSharedProjectSnapshot;
    let adopted = 0;
    const adopt = f.observerDb.adoptSharedSessionBaseline;
    f.observerDb.adoptSharedSessionBaseline = records => { adopted++; return adopt(records); };
    f.observerDb.readSharedProjectSnapshot = async project => { const rows = await read(project); await gate.promise; return rows; };
    await f.peerUpdate(); await f.clock.tick();
    f.h.changeProject(); f.h.context.spaRouteGeneration++;
    f.h.context.state = State.normalizePanelState({ activeSessionId: 'new-scope', sessions: [{ id: 'new-scope', task: 'navigation draft' }] });
    gate.resolve(); await drain();
    assert.equal(adopted, 0); assert.equal(currentTask(f), 'navigation draft');
    assert.equal(f.clock.pending(), 0);
  } finally { gate.resolve(); f.close(); }
});
