'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SessionState = require('../extension/src/shared/sessionState');
const { create } = require('../extension/src/content/sessionForkController');
const managerContext = { window: {}, document: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/src/content/sessionManager.js'), 'utf8'), managerContext);
const SessionManager = managerContext.window.CodexOverleafSessionManager;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ delayedSave = false, renderErrors = [] } = {}) {
  let state = SessionState.normalizePanelState({
    sessions: [{ ...SessionState.createSession({
      title: 'Source session', task: 'original draft', codexThreadId: 'source-thread',
      runs: [{ id: 'source-run', status: 'completed', task: 'original task', codexThreadId: 'source-thread', codexTurnId: 'source-turn' }]
    }), id: 'source-session' }], activeSessionId: 'source-session'
  });
  let scope = { accountScopeId: 'account-a', projectId: 'project-a', generation: 1 };
  const native = deferred(), nativeEntered = deferred(), save = deferred(), saveEntered = deferred();
  const requests = [], saves = [], notices = [], renders = [];
  const getState = () => state;
  const setState = next => { state = next; };
  const sendBackgroundNative = async request => {
    requests.push(request);
    if (request.method === 'codex.thread.fork') {
      nativeEntered.resolve();
      return native.promise;
    }
    if (request.method === 'codex.history.clearPlugin') return { ok: true };
    throw new Error(`Unexpected request ${request.method}`);
  };
  const controller = create({
    SessionState, getState, setState, getScope: () => scope, sendBackgroundNative,
    saveState: async () => {
      saves.push(structuredClone(state));
      saveEntered.resolve();
      if (delayedSave) return save.promise;
    },
    applyStateToPanel: () => {
      renders.push(state);
      if (renderErrors[renders.length - 1]) throw renderErrors[renders.length - 1];
    },
    showPluginToast: (...args) => notices.push(args), tr: key => key
  });
  const manager = SessionManager.create({
    SessionState,
    SessionMenuView: { create: () => ({ applySessionLabel() {}, bindActiveSessionHeader() {}, closeSessionMenu() {} }) },
    getState, setState, tr: key => key, showPluginConfirm: async () => true,
    getPanel: () => ({ querySelector: () => ({ focus() {} }) }),
    readPanelInputs() {}, applyStateToPanel() {}, syncSessionProvider: async () => {},
    saveState: async () => {}, saveStateSoon() {}, sendBackgroundNative,
    showPluginToast() {}, getSessionPanelInstance: () => null, formatSessionTime: value => value
  });
  return {
    controller, manager, native, nativeEntered, save, saveEntered, requests, saves, notices, renders, getState, setState,
    setScope: next => { scope = { ...scope, ...next }; },
    draft: value => setState(SessionState.updateActiveSession(getState(), { task: value })),
    succeed: () => native.resolve({ ok: true, result: { threadId: 'forked-thread' } })
  };
}

function draft(h, id = 'source-session') {
  return h.getState().sessions.find(session => session.id === id)?.task;
}
const options = { timeout: 3000 };

test('fork merges a source draft edited during the Native wait', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  h.draft('later source draft');
  h.succeed();
  const fork = await pending;
  assert.equal(draft(h), 'later source draft');
  assert.equal(h.saves[0].sessions[0].task, 'later source draft');
  assert.equal(h.getState().activeSessionId, fork.id);
  assert.equal(fork.runs[0].forkSnapshot, true);
});

test('a real SessionManager new session and its active draft survive a late fork', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  await h.manager.startNewSession();
  const newId = h.getState().activeSessionId;
  h.draft('new conversation draft');
  h.succeed();
  const fork = await pending;
  assert.equal(draft(h, newId), 'new conversation draft');
  assert.equal(h.getState().activeSessionId, newId);
  assert.equal(h.getState().sessions.length, 3);
  assert.ok(h.getState().sessions.some(session => session.id === fork.id));
});

test('fork history and provider settings remain paired with the dispatched Native origin', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  const source = h.getState().sessions[0];
  const originalProvider = source.providerId;
  source.providerId = 'new-provider';
  source.model = 'new-model';
  source.codexThreadId = 'later-thread';
  source.runs[0].task = 'later task';
  h.succeed();
  const fork = await pending;
  assert.equal(h.requests[0].params.threadId, 'source-thread');
  assert.equal(fork.providerId, originalProvider);
  assert.equal(fork.runs[0].task, 'original task');
  assert.equal(h.getState().sessions[0].providerId, 'new-provider');
});

test('fork merge leaves an unrelated running session running', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  h.getState().sessions.push({ ...SessionState.createSession({ title: 'Busy' }), id: 'busy',
    runs: [{ id: 'live-run', status: 'running' }] });
  h.succeed();
  await pending;
  assert.equal(h.getState().sessions.find(session => session.id === 'busy').runs[0].status, 'running');
});

test('source removal discards and cleans the unattached Native fork', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  await h.nativeEntered.promise;
  const replacement = SessionState.normalizePanelState({
    sessions: [SessionState.createSession({ id: 'replacement', task: 'new view' })], activeSessionId: 'replacement'
  });
  h.setState(replacement);
  h.succeed();
  assert.equal(await pending, null);
  assert.equal(h.getState(), replacement);
  assert.equal(h.saves.length, 0);
  assert.equal(h.renders.length, 0);
  assert.equal(h.notices.length, 0);
  assert.equal(h.requests[1].method, 'codex.history.clearPlugin');
  assert.equal(h.requests[1].params.threadId, 'forked-thread');
});

for (const changed of [{ accountScopeId: 'account-b' }, { projectId: 'project-b' }, { generation: 2 }]) {
  test(`fork rechecks scope after Native wait: ${Object.keys(changed)[0]}`, options, async () => {
    const h = harness();
    const before = h.getState();
    const pending = h.controller.forkRunFromNode('source-run');
    await h.nativeEntered.promise;
    h.setScope(changed);
    h.succeed();
    assert.equal(await pending, null);
    assert.equal(h.getState(), before);
    assert.equal(h.saves.length, 0);
    assert.equal(h.renders.length, 0);
    assert.equal(h.notices.length, 0);
    assert.equal(h.requests[1].params.threadId, 'forked-thread');
  });
}

test('a late Native rejection does not display failure in a new scope', options, async () => {
  const h = harness();
  const pending = h.controller.forkRunFromNode('source-run');
  await h.nativeEntered.promise;
  h.setScope({ generation: 2 });
  h.native.reject(new Error('old project Native failure'));
  assert.equal(await pending, null);
  assert.equal(h.notices.length, 0);
});

test('save rollback preserves source changes and removes only the untouched fork', options, async () => {
  const h = harness({ delayedSave: true });
  const pending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  await h.saveEntered.promise;
  h.setState(SessionState.setActiveSession(h.getState(), 'source-session'));
  h.draft('draft during save');
  const error = new Error('save failed');
  h.save.reject(error);
  await assert.rejects(pending, value => value === error);
  assert.equal(draft(h), 'draft during save');
  assert.deepEqual(h.getState().sessions.map(session => session.id), ['source-session']);
  assert.equal(h.getState().activeSessionId, 'source-session');
  assert.equal(h.requests[1].params.threadId, 'forked-thread');
});

for (const compensationFails of [false, true]) {
  test(`initial fork render failure cleans the new thread even when compensation ${compensationFails ? 'throws' : 'succeeds'}`, options, async () => {
    const initialError = new Error('initial render failed');
    const h = harness({ renderErrors: [initialError, compensationFails ? new Error('compensation render failed') : null] });
    const before = h.getState();
    const pending = h.controller.forkRunFromNode('source-run');
    h.succeed();
    await assert.rejects(pending, error => error === initialError);
    assert.equal(h.getState(), before);
    assert.equal(h.saves.length, 0);
    assert.equal(h.renders.length, 2);
    assert.equal(h.requests[1].method, 'codex.history.clearPlugin');
    assert.equal(h.requests[1].params.threadId, 'forked-thread');
    assert.equal(h.notices.at(-1)[0], initialError.message);
  });
}

test('compensation render failure neither masks the persistence error nor skips thread cleanup', options, async () => {
  const h = harness({ delayedSave: true, renderErrors: [null, new Error('compensation render failed')] });
  const pending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  await h.saveEntered.promise;
  h.setState(SessionState.setActiveSession(h.getState(), 'source-session'));
  h.draft('preserved despite render error');
  const saveError = new Error('save failed');
  h.save.reject(saveError);
  await assert.rejects(pending, error => error === saveError);
  assert.equal(draft(h), 'preserved despite render error');
  assert.equal(h.getState().sessions.length, 1);
  assert.equal(h.requests[1].params.threadId, 'forked-thread');
});

test('save rollback retains later edits to the new fork and its Native thread', options, async () => {
  const h = harness({ delayedSave: true });
  const pending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  await h.saveEntered.promise;
  const forkId = h.getState().activeSessionId;
  h.draft('draft in new fork');
  h.save.reject(new Error('save failed'));
  await assert.rejects(pending, /save failed/);
  assert.equal(draft(h, forkId), 'draft in new fork');
  assert.equal(h.getState().sessions.find(session => session.id === forkId).codexThreadId, 'forked-thread');
  assert.equal(h.requests.length, 1);
  assert.equal(h.notices.at(-1)[1].status, 'failed');
});

test('save rollback preserves a new SessionManager session and its active selection', options, async () => {
  const h = harness({ delayedSave: true });
  const pending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  await h.saveEntered.promise;
  await h.manager.startNewSession();
  const selected = h.getState().activeSessionId;
  h.draft('later session');
  h.save.reject(new Error('save failed'));
  await assert.rejects(pending, /save failed/);
  assert.equal(h.getState().activeSessionId, selected);
  assert.equal(draft(h, selected), 'later session');
  assert.equal(h.getState().sessions.length, 2);
});

test('concurrent forks merge against live sessions and reserve distinct titles', options, async () => {
  const h = harness();
  const firstPending = h.controller.forkRunFromNode('source-run');
  const secondPending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(h.getState().sessions.length, 3);
  assert.notEqual(first.title, second.title);
  assert.equal(h.getState().activeSessionId, first.id);
});

test('save rollback detects an in-place edit rather than relying on state reference equality', options, async () => {
  const h = harness({ delayedSave: true });
  const pending = h.controller.forkRunFromNode('source-run');
  h.succeed();
  await h.saveEntered.promise;
  h.getState().sessions[0].task = 'in-place edit';
  h.save.reject(new Error('save failed'));
  await assert.rejects(pending, /save failed/);
  assert.equal(draft(h), 'in-place edit');
});

for (const failed of [false, true]) {
  test(`scope change during ${failed ? 'failed' : 'successful'} save leaves the replacement view alone`, options, async () => {
    const h = harness({ delayedSave: true });
    const pending = h.controller.forkRunFromNode('source-run');
    h.succeed();
    await h.saveEntered.promise;
    const replacement = SessionState.normalizePanelState({
      sessions: [SessionState.createSession({ id: 'replacement', task: 'new scope' })], activeSessionId: 'replacement'
    });
    h.setScope({ generation: 2 });
    h.setState(replacement);
    const renderCount = h.renders.length;
    const error = new Error('old scope save failed');
    if (failed) h.save.reject(error); else h.save.resolve();
    if (failed) await assert.rejects(pending, value => value === error);
    else assert.equal(await pending, null);
    assert.equal(h.getState(), replacement);
    assert.equal(h.renders.length, renderCount);
    assert.equal(h.notices.length, 0);
    assert.equal(h.requests.length, 1, 'a save may already have persisted the fork in its original scope');
  });
}

test('runtime supplies the live account, project and route generation to the fork owner', () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension/src/content/contentRuntime.js'), 'utf8');
  const declaration = source.match(/const sessionForkController = Modules\.SessionForkController\.create\(\{[\s\S]*?\n  \}\);/);
  assert.ok(declaration);
  let deps;
  const context = {
    Modules: { SessionState, SessionForkController: { create: value => { deps = value; return {}; } } },
    state: {}, sendBackgroundNative() {}, saveState() {}, applyStateToPanel() {}, showPluginToast() {}, tr() {},
    cachedAccountScopeId: 'account-a', getCurrentProjectId: () => 'project-a', spaRouteGeneration: 1
  };
  vm.runInNewContext(declaration[0], context);
  assert.deepEqual({ ...deps.getScope() }, { accountScopeId: 'account-a', projectId: 'project-a', generation: 1 });
  context.spaRouteGeneration = 2;
  assert.equal(deps.getScope().generation, 2);
});
