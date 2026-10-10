'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(overrides = {}) {
  const a = { id: 'old', status: 'running', events: [] };
  const b = { id: 'next', status: 'running', events: [] };
  const session = { id: 'session', createdAt: 'first', runs: [a, b] };
  const containers = new Map([[a.id, {}], [b.id, {}]]), painted = new Map();
  let activeSession = session.id, current = a;
  let scope = { accountScopeId: 'account', projectId: 'project', generation: 1 };
  const context = { window: {}, Date: class extends Date { static now() { return 1000; } } };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../extension/src/content/runGuidanceController.js'), 'utf8'), context);
  const controller = context.window.CodexOverleafRunGuidanceController.create({
    findRunRecord: (id, sessionId) => sessionId === session.id ? session.runs.find(run => run.id === id) : null,
    getSessionCreatedAt: id => id === session.id ? session.createdAt : null,
    getActiveSessionId: () => activeSession,
    getScope: () => ({ ...scope }),
    getRunRoot: target => activeSession === target.sessionId ? { querySelector: () => containers.get(target.recordId) } : null,
    getCurrentRunView: () => ({ recordId: current.id, sessionId: session.id }),
    RunGuidanceView: { reconcileGuidance(container, events) { painted.set(container, JSON.parse(JSON.stringify(events))); } },
    tx: en => en,
    appendRunEvent() { throw new Error('guidance cannot use the current-run-only event append path'); },
    ...overrides
  });
  const target = id => ({ recordId: a.id, sessionId: session.id, sessionCreatedAt: session.createdAt, guidanceId: id });
  return { a, b, session, controller, painted, containers, target,
    switchRun() { current = b; }, switchSession(id) { activeSession = id; }, switchScope() { scope.generation++; } };
}

test('sending is an immediate memory-only projection, including a rebuilt view', () => {
  const f = fixture(); const token = f.controller.preview('Keep citations', f.target('g1'));
  assert.ok(token);
  assert.equal(f.a.events.length, 0);
  assert.equal(f.controller.getPending({ ...f.a })[0].guidancePending, true);
  assert.equal(f.painted.get(f.containers.get('old'))[0].status, 'steering');
  f.a.status = 'cancelled';
  assert.equal(f.controller.getPending(f.a).length, 1, 'an outstanding ACK is still pending after settlement');
  f.controller.clearPreview(token);
  assert.equal(f.controller.getPending(f.a).length, 0);
  assert.equal(f.painted.get(f.containers.get('old')).length, 0);
  assert.equal(f.a.events.length, 0);
});

test('reverse ACKs persist send order and bind to the original run, including equal clock ticks', () => {
  const f = fixture(), t1 = f.controller.preview('Same text', f.target('g1')), t2 = f.controller.preview('Same text', f.target('g2'));
  assert.ok(Date.parse(t1.event.timestamp) < Date.parse(t2.event.timestamp));
  f.switchRun(); f.a.status = 'completed';
  f.controller.upsert('Same text', { ...f.target('g2'), timestamp: t2.event.timestamp, status: 'completed' });
  f.controller.upsert('Same text', { ...f.target('g1'), timestamp: t1.event.timestamp, status: 'completed' });
  f.controller.clearPreview(t1); f.controller.clearPreview(t2);
  assert.equal(f.b.events.length, 0);
  assert.equal(f.a.events.length, 2);
  const ordered = [...f.a.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  assert.deepEqual(ordered.map(event => event.guidanceId), ['g1', 'g2']);
  assert.equal(ordered.every(event => !event.guidancePending && event.status === 'completed'), true);
  f.controller.upsert('Same text', { ...f.target('g1'), status: 'completed' });
  assert.equal(f.a.events.length, 2, 'repeated confirmation updates one stable input identity');
  assert.equal(f.a.events.find(event => event.guidanceId === 'g1').timestamp, t1.event.timestamp);
});

test('an old cleanup cannot remove a replacement preview, and session replacement rejects late confirmation', () => {
  const f = fixture(), target = f.target('g1');
  const old = f.controller.preview('old attempt', target), next = f.controller.preview('new attempt', target);
  f.controller.clearPreview(old);
  assert.equal(f.controller.getPending(f.a)[0].title, 'new attempt');
  f.session.createdAt = 'replacement';
  assert.equal(f.controller.upsert('old attempt', { ...target, timestamp: old.event.timestamp }), null);
  assert.equal(f.a.events.length, 0);
  assert.equal(f.controller.getPending(f.a).length, 0);
  f.controller.clearPreview(next);
});

test('a pending input is not projected into another session with a colliding run id', () => {
  const f = fixture(); f.controller.preview('only old session', f.target('g1'));
  f.switchSession('other');
  assert.equal(f.controller.getPending({ id: 'old', events: [] }).length, 0);
  f.switchSession('session');
  assert.equal(f.controller.getPending(f.a).length, 1);
});

function wiredFixture() {
  const Queue = require('../extension/src/shared/runInputQueue');
  const Scheduler = require('../extension/src/content/runQueueScheduler');
  const Storage = require('../extension/src/shared/storageDb');
  const f = fixture(), receipts = [], saved = [];
  f.session.pendingInputs = [];
  let current = { recordId: f.a.id, sessionId: f.session.id, nativeRequestId: 'request',
    runProjectId: 'project', activeTurn: { threadId: 'thread', turnId: 'turn' } };
  const coordinator = Scheduler.createCoordinator({
    getSession: id => id === f.session.id ? f.session : null,
    getActiveSession: () => f.session,
    getCurrentRun: () => current,
    setQueue: (_id, queue) => { f.session.pendingInputs = queue; },
    previewGuidance: f.controller.preview,
    clearGuidancePreview: f.controller.clearPreview,
    appendGuidance: f.controller.upsert,
    save: async () => { saved.push(JSON.parse(JSON.stringify(Storage.buildSessionRecord(f.session)))); },
    sendSteer: () => new Promise((resolve, reject) => receipts.push({ resolve, reject }))
  });
  let id = 0;
  function enqueue(text) {
    const result = Queue.enqueue(f.session.pendingInputs, { text, sourceRunId: 'an-older-run' },
      { randomUUID: () => 'guidance-' + (++id) });
    f.session.pendingInputs = result.queue;
    return result.item.id;
  }
  return { ...f, coordinator, receipts, saved, enqueue, settle() { current = null; f.a.status = 'completed'; } };
}

test('coordinator → controller → storage commits the clicked run with send order despite reverse late ACKs', async () => {
  const f = wiredFixture();
  const first = f.coordinator.guide(f.enqueue('First')), second = f.coordinator.guide(f.enqueue('Second'));
  assert.equal(f.controller.getPending(f.a).length, 2, 'previews exist synchronously');
  for (let tick = 0; tick < 10 && f.receipts.length < 2; tick++) await Promise.resolve();
  assert.equal(f.receipts.length, 2);
  assert.equal(f.saved.every(s => !s.runs[0].events.length), true, 'no temporary bubble enters a durable snapshot');
  f.settle(); f.switchRun();
  f.receipts[1].resolve({ ok: true }); await second;
  f.receipts[0].resolve({ ok: true }); await first;
  assert.equal(f.b.events.length, 0);
  assert.equal(f.session.pendingInputs.length, 0);
  assert.equal(f.controller.getPending(f.a).length, 0);
  const restored = f.saved.at(-1).runs[0].events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  assert.deepEqual(restored.map(event => event.title), ['First', 'Second']);
  assert.equal(new Set(restored.map(event => event.guidanceId)).size, 2);
  assert.equal(restored.every(event => event.status === 'completed' && !event.guidancePending), true);
});

test('unknown delivery clears the composed preview and retains only paused durable input for recovery', async () => {
  const f = wiredFixture(), pending = f.coordinator.guide(f.enqueue('Only once'));
  for (let tick = 0; tick < 10 && !f.receipts.length; tick++) await Promise.resolve();
  f.receipts[0].reject(new Error('connection lost')); await pending;
  assert.equal(f.controller.getPending(f.a).length, 0);
  assert.equal(f.a.events.length, 0);
  assert.equal(f.saved.at(-1).runs[0].events.length, 0);
  assert.equal(f.session.pendingInputs[0].status, 'paused');
  assert.equal(f.session.pendingInputs[0].pauseReason, 'steer_delivery_unknown');
  assert.equal(f.receipts.length, 1);
});


test('scope changes suppress old previews even when session and run identifiers collide', () => {
  const f = fixture(), token = f.controller.preview('Old scope', f.target('g1'));
  const oldPaint = f.painted.get(f.containers.get('old'));
  f.switchScope();
  assert.equal(f.controller.getPending(f.a).length, 0);
  f.controller.clearPreview(token);
  assert.equal(f.painted.get(f.containers.get('old')), oldPaint, 'old cleanup must not repaint the replacement scope');
});


test('a synchronous preview renderer failure leaves no orphaned pending message', () => {
  const f = fixture({ RunGuidanceView: { reconcileGuidance() { throw new Error('render failed'); } } });
  assert.throws(() => f.controller.preview('Input', f.target('g1')), /render failed/);
  assert.equal(f.controller.getPending(f.a).length, 0);
  assert.equal(f.a.events.length, 0);
});


test('presentation failure cannot prevent an acknowledged input from reaching persistence', () => {
  let fail = false, errors = 0;
  const f = fixture({ RunGuidanceView: { reconcileGuidance() { if (fail) throw new Error('render failed'); } },
    onPresentationError: () => { errors++; } });
  const token = f.controller.preview('Confirmed', f.target('g1'));
  fail = true;
  assert.doesNotThrow(() => f.controller.upsert('Confirmed', { ...f.target('g1'), timestamp: token.event.timestamp }));
  assert.doesNotThrow(() => f.controller.clearPreview(token));
  assert.equal(f.a.events[0].status, 'completed');
  assert.equal(f.controller.getPending(f.a).length, 0);
  assert.equal(errors, 2);
});
