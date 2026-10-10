const assert = require('node:assert/strict');
const test = require('node:test');
const Queue = require('../extension/src/shared/runInputQueue');
const Scheduler = require('../extension/src/content/runQueueScheduler');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  let itemNumber = 0;
  const session = { id: 'session', createdAt: 'session-created', pendingInputs: [] };
  const state = {
    session,
    active: session,
    scope: { projectId: 'project', accountScopeId: 'account', generation: 1 },
    run: { sessionId: session.id, recordId: 'run-original', nativeRequestId: 'request-original',
      runProjectId: 'project', activeTurn: { threadId: 'thread-original', turnId: 'turn-original' } },
    previews: new Map(), cleared: [], confirmed: [], visible: [], saves: [], sends: [], toasts: []
  };
  const container = {};
  const coordinator = Scheduler.createCoordinator({
    getSession: id => state.session?.id === id ? state.session : null,
    getActiveSession: () => state.active,
    getCurrentRun: () => state.run,
    getGuideScope: () => state.scope,
    setQueue: (id, queue) => { if (state.session?.id === id) state.session.pendingInputs = queue; },
    getContainer: () => container,
    createView: () => ({ render: queue => { state.visible = queue.map(item => ({ ...item })); } }),
    previewGuidance: (text, target) => {
      const token = { text, target, event: { timestamp: 'preview-' + state.previews.size } };
      state.previews.set(token, token);
      return token;
    },
    clearGuidancePreview: token => { state.cleared.push(token); state.previews.delete(token); },
    appendGuidance: (text, target) => state.confirmed.push({ text, target }),
    save: async payload => { state.saves.push(payload?.queueMutation || null); },
    sendSteer: async payload => { state.sends.push(payload); return { ok: true }; },
    toast: (message, severity) => state.toasts.push({ message, severity }),
    tr: key => key,
    ...overrides
  });
  function enqueue(text = 'follow up') {
    const result = Queue.enqueue(state.session.pendingInputs, { text, sourceRunId: 'older-run' }, {
      randomUUID: () => 'item-' + (++itemNumber), now: () => new Date(Date.UTC(2026, 9, 10, 0, 0, itemNumber)).toISOString()
    });
    state.session.pendingInputs = result.queue;
    coordinator.render();
    return result.item.id;
  }
  return { state, coordinator, enqueue };
}

test('Guide projects before the first await and hides only its steering row', async () => {
  const gate = deferred();
  const f = fixture({ preflightGuide: () => gate.promise });
  const first = f.enqueue(), second = f.enqueue('stay queued');
  const pending = f.coordinator.guide(first);
  assert.equal(f.state.previews.size, 1, 'the user bubble is visible while preflight is pending');
  assert.deepEqual(f.state.visible.map(item => item.id), [second]);
  assert.deepEqual(f.state.session.pendingInputs.map(item => item.status), ['steering', 'queued']);
  const token = [...f.state.previews.keys()][0];
  assert.deepEqual(token.target, { guidanceId: first, sessionId: 'session', recordId: 'run-original',
    sessionCreatedAt: 'session-created' });
  assert.equal(f.state.confirmed.length, 0, 'the preview never claims confirmed delivery');
  gate.resolve(); await pending;
  assert.equal(f.state.previews.size, 0);
  assert.deepEqual(f.state.cleared, [token]);
  assert.equal(f.state.confirmed.length, 1);
  assert.equal(f.state.confirmed[0].target.recordId, 'run-original');
});

test('a coordinator without a preview implementation keeps the steering row visible', async () => {
  const gate = deferred();
  const f = fixture({ previewGuidance: undefined, preflightGuide: () => gate.promise });
  const id = f.enqueue();
  const pending = f.coordinator.guide(id);
  assert.equal(f.state.visible[0].status, 'steering');
  gate.resolve(); await pending;
  assert.equal(f.state.cleared.length, 0);
});

for (const key of ['projectId', 'accountScopeId', 'generation']) {
  test(`an earlier preview cannot hide matching queue identities after changing ${key}`, async () => {
    const gate = deferred();
    const f = fixture({ preflightGuide: () => gate.promise });
    const id = f.enqueue();
    const pending = f.coordinator.guide(id);
    assert.equal(f.state.visible.length, 0);
    f.state.scope[key] = 'new-scope-value';
    f.coordinator.render();
    assert.equal(f.state.visible.length, 1, 'the new scope owns its own queue projection');
    assert.equal(f.state.visible[0].id, id);
    gate.resolve();
    await assert.rejects(pending, error => error.code === 'codex_turn_mismatch');
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.state.previews.size, 0);
    assert.equal(f.state.visible.length, 1);
  });
}

test('a confirmed steer stays confirmed when its persistence fails', async () => {
  const f = fixture({ save: async ({ queueMutation }) => {
    f.state.saves.push(queueMutation);
    if (queueMutation.type === 'remove') throw new Error('storage unavailable after acknowledgement');
  } });
  const id = f.enqueue();
  await assert.rejects(f.coordinator.guide(id), /storage unavailable after acknowledgement/);
  assert.equal(f.state.confirmed.length, 1);
  assert.equal(f.state.previews.size, 0);
  assert.equal(f.state.session.pendingInputs.length, 0);
  assert.deepEqual(f.state.saves.map(mutation => mutation.type), ['transition', 'remove']);
  assert.equal(f.state.toasts.length, 0, 'the caller reports persistence failure without an unknown-delivery toast');
});

for (const outcome of ['blocked', 'preflight-error', 'save-error', 'not-dispatched', 'known-failure', 'unknown']) {
  test(`Guide clears its temporary bubble on ${outcome} and keeps the recovered queue row`, async () => {
    const f = fixture({
      preflightGuide: async () => {
        if (outcome === 'blocked') return { blocked: true };
        if (outcome === 'preflight-error') throw new Error('preflight failed');
      },
      save: async payload => {
        f.state.saves.push(payload?.queueMutation || null);
        if (outcome === 'save-error' && f.state.saves.length === 1) throw new Error('save failed');
      },
      sendSteer: async payload => {
        f.state.sends.push(payload);
        if (outcome === 'not-dispatched') throw Object.assign(new Error('compatibility cancelled'), { requestDispatched: false });
        if (outcome === 'known-failure') return { ok: false, error: { code: 'codex_turn_mismatch' } };
        if (outcome === 'unknown') throw new Error('transport disconnected');
        return { ok: true };
      }
    });
    const id = f.enqueue();
    await f.coordinator.guide(id).catch(() => {});
    assert.equal(f.state.previews.size, 0);
    assert.equal(f.state.cleared.length, 1);
    assert.equal(f.state.confirmed.length, 0);
    assert.equal(f.state.visible.length, 1);
    assert.equal(f.state.visible[0].status, outcome === 'unknown' ? 'paused' : 'queued');
    assert.equal(f.state.sends.length, ['blocked', 'preflight-error', 'save-error'].includes(outcome) ? 0 : 1);
    if (outcome === 'unknown') {
      assert.equal(f.state.visible[0].pauseReason, 'steer_delivery_unknown');
      await f.coordinator.guide(id);
      assert.equal(f.state.sends.length, 1, 'an uncertain delivery is never automatically resent');
    }
  });
}

test('multiple identical inputs keep distinct previews and click timestamps despite reverse acknowledgements', async () => {
  const gates = new Map();
  const f = fixture({ sendSteer: payload => {
    const gate = deferred(); gates.set(payload.clientUserMessageId, gate); return gate.promise;
  } });
  const first = f.enqueue(), second = f.enqueue(), queued = f.enqueue('later');
  const pendingFirst = f.coordinator.guide(first), pendingSecond = f.coordinator.guide(second);
  assert.equal(f.state.previews.size, 2);
  assert.deepEqual(f.state.visible.map(item => item.id), [queued]);
  await new Promise(resolve => setImmediate(resolve));
  gates.get(second).resolve({ ok: true }); await pendingSecond;
  assert.equal(f.state.previews.size, 1);
  assert.deepEqual(f.state.confirmed.map(entry => [entry.target.guidanceId, entry.target.timestamp]), [[second, 'preview-1']]);
  gates.get(first).resolve({ ok: true }); await pendingFirst;
  assert.equal(f.state.previews.size, 0);
  assert.deepEqual(f.state.confirmed.map(entry => [entry.target.guidanceId, entry.target.timestamp]),
    [[second, 'preview-1'], [first, 'preview-0']]);
});

for (const change of ['remove', 'replace-item', 'replace-session', 'scope', 'settle', 'new-run']) {
  for (const response of ['confirmed', 'known-failure', 'unknown']) {
    test(`late ${response} respects captured ownership after ${change}`, async () => {
      const ack = deferred(), entered = deferred();
      const f = fixture({ sendSteer: () => { entered.resolve(); return ack.promise; } });
      const id = f.enqueue();
      const pending = f.coordinator.guide(id);
      await entered.promise;
      const original = f.state.session.pendingInputs[0];
      if (change === 'remove') f.state.session.pendingInputs = [];
      if (change === 'replace-item') f.state.session.pendingInputs = [{ ...original,
        createdAt: '2040-01-01T00:00:00.000Z', text: 'replacement', clientUserMessageId: 'replacement' }];
      if (change === 'replace-session') f.state.session.createdAt = 'replacement-session';
      if (change === 'scope') f.state.scope.generation++;
      if (change === 'settle') f.state.run = null;
      if (change === 'new-run') f.state.run = { ...f.state.run, recordId: 'run-new', activeTurn: { threadId: 'thread-new', turnId: 'turn-new' } };
      const expectedQueue = structuredClone(f.state.session.pendingInputs);
      if (response === 'unknown') ack.reject(new Error('connection lost'));
      else ack.resolve(response === 'confirmed' ? { ok: true } : { ok: false, error: { code: 'codex_turn_mismatch' } });
      await pending;
      assert.equal(f.state.previews.size, 0);
      if (['remove', 'replace-item', 'replace-session', 'scope'].includes(change)) {
        assert.deepEqual(f.state.session.pendingInputs, expectedQueue, 'late replies cannot mutate another queue owner');
        assert.equal(f.state.saves.filter(mutation => mutation?.type === 'remove').length, 0);
      } else {
        assert.equal(f.state.session.pendingInputs.length, response === 'confirmed' ? 0 : 1);
      }
      const shouldAppend = response === 'confirmed' && !['replace-session', 'scope'].includes(change);
      assert.equal(f.state.confirmed.length, shouldAppend ? 1 : 0);
      if (shouldAppend) assert.equal(f.state.confirmed[0].target.recordId, 'run-original');
    });
  }
}

test('an old attempt cannot clear the preview or queue ownership of a newer same-ID attempt', async () => {
  const gates = [];
  const f = fixture({ preflightGuide: () => {
    const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const id = f.enqueue();
  const first = f.coordinator.guide(id);
  const firstToken = [...f.state.previews.keys()][0];
  f.state.session.pendingInputs = Queue.returnToQueue(f.state.session.pendingInputs, id);
  const second = f.coordinator.guide(id);
  const secondToken = [...f.state.previews.keys()][1];
  gates[0].resolve();
  await assert.rejects(first, error => error.code === 'codex_turn_mismatch');
  assert.equal(f.state.previews.has(firstToken), false);
  assert.equal(f.state.previews.has(secondToken), true);
  assert.equal(f.state.session.pendingInputs[0].status, 'steering');
  assert.equal(f.state.visible.length, 0);
  gates[1].resolve(); await second;
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.previews.size, 0);
});

for (const outcome of ['confirmed', 'known-failure', 'unknown']) {
  test(`a dispatched steer ${outcome} handles cancellation-paused ownership without duplicate delivery`, async () => {
    const ack = deferred(), entered = deferred();
    const f = fixture({ sendSteer: () => { entered.resolve(); return ack.promise; } });
    const id = f.enqueue();
    const pending = f.coordinator.guide(id);
    await entered.promise;
    f.state.session.pendingInputs = Queue.pauseAll(f.state.session.pendingInputs, 'cancelled');
    f.state.run = null;
    f.coordinator.render();
    assert.equal(f.state.previews.size, 1, 'the pending acknowledgement keeps its sending bubble');
    assert.equal(f.state.visible.length, 0, 'the paused copy stays hidden until its preview is cleared');
    if (outcome === 'unknown') ack.reject(new Error('connection lost'));
    else ack.resolve(outcome === 'confirmed' ? { ok: true } : { ok: false, error: { code: 'codex_turn_mismatch' } });
    await pending;
    assert.equal(f.state.previews.size, 0);
    assert.equal(f.state.confirmed.length, outcome === 'confirmed' ? 1 : 0);
    if (outcome === 'confirmed') {
      assert.deepEqual(f.state.session.pendingInputs, []);
      assert.equal(f.state.saves.at(-1).type, 'remove');
    } else {
      assert.equal(f.state.visible.length, 1, 'the recovery row returns after the sending bubble is cleared');
      assert.equal(f.state.session.pendingInputs[0].status, 'paused');
      assert.equal(f.state.session.pendingInputs[0].pauseReason,
        outcome === 'unknown' ? 'steer_delivery_unknown' : 'cancelled');
    }
    assert.equal(f.coordinator.scheduler.scheduleOne('session'), false);
  });
}
