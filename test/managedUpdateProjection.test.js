const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../extension/src/shared/managedUpdateProjection.js'),
  'utf8'
);
const sandbox = { window: {}, Date };
vm.runInNewContext(source, sandbox);
const projection = sandbox.window.CodexOverleafManagedUpdateProjection;

test('managed update projection normalizes aliases and persisted fields', () => {
  const state = projection.normalize({
    state: 'waiting-for-safe-point',
    currentVersion: 'v2.2.1',
    latestVersion: 'v2.2.2',
    blocker: 'busy',
    message: 'x'.repeat(400)
  });
  assert.equal(state.state, 'waiting_for_idle');
  assert.equal(state.currentVersion, '2.2.1');
  assert.equal(state.latestVersion, '2.2.2');
  assert.deepEqual(Array.from(state.blockers), ['busy']);
  assert.equal(state.message.length, 300);
});

test('managed update projection derives deadlines without rejecting recovery transitions', () => {
  const checking = projection.transition(
    { state: 'idle', currentVersion: '2.2.1' },
    { state: 'checking', currentVersion: '2.2.1' },
    { merge: false, now: 1000 }
  );
  assert.equal(checking.deadlineAt, 31000);
  const applying = projection.transition(
    { state: 'staged', currentVersion: '2.2.1' },
    { state: 'applying', currentVersion: '2.2.1' },
    { merge: false, now: 1000 }
  );
  assert.equal(applying.phaseStartedAt, 1000);
  assert.equal(applying.deadlineAt, 91000);
  assert.equal(projection.isLegalTransition('staged', 'applying'), true);
  assert.equal(projection.isLegalTransition('idle', 'committed'), false);
  assert.equal(projection.transition(applying, { state: 'committed' }).state, 'committed');
});

test('same-phase observations refresh heartbeat without extending the deadline', () => {
  const checking = projection.transition(
    { state: 'idle', currentVersion: '2.2.1' },
    { state: 'checking', currentVersion: '2.2.1' },
    { merge: false, now: 1000 }
  );
  const heartbeat = projection.transition(checking, { message: 'still checking' }, { now: 5000 });
  assert.equal(heartbeat.phaseStartedAt, 1000);
  assert.equal(heartbeat.deadlineAt, 31000);
  assert.equal(heartbeat.heartbeatAt, 5000);
});

test('managed update command transitions reject illegal jumps while observed recovery remains permissive', () => {
  assert.equal(
    projection.transitionCommand(
      { state: 'staged', currentVersion: '2.2.1' },
      { state: 'applying', currentVersion: '2.2.1' },
      { merge: false, now: 1000 }
    ).state,
    'applying'
  );
  assert.throws(
    () => projection.transitionCommand(
      { state: 'idle', currentVersion: '2.2.1' },
      { state: 'committed', currentVersion: '2.2.2' },
      { merge: false }
    ),
    error => error?.code === 'managed_update_transition_invalid'
      && error?.from === 'idle'
      && error?.to === 'committed'
  );
  assert.equal(
    projection.transition(
      { state: 'idle', currentVersion: '2.2.1' },
      { state: 'committed', currentVersion: '2.2.2' },
      { merge: false }
    ).state,
    'committed'
  );
});

test('postponing a staged update can return to the available state', () => {
  assert.equal(
    projection.transitionCommand(
      { state: 'staged', currentVersion: '2.2.1', latestVersion: '2.2.2' },
      { state: 'update_available' }
    ).state,
    'update_available'
  );
  assert.equal(
    projection.transitionCommand(
      { state: 'waiting_for_idle', currentVersion: '2.2.1', latestVersion: '2.2.2' },
      { state: 'update_available' }
    ).state,
    'update_available'
  );
  assert.equal(
    projection.transitionCommand(
      { state: 'failed', currentVersion: '2.2.1', latestVersion: '2.2.2' },
      { state: 'update_available', code: '', message: '' }
    ).state,
    'update_available'
  );
});

test('managed update projection owns progress, stages, and surface activity', () => {
  assert.equal(projection.progressFor('waiting'), 55);
  assert.equal(projection.progressFor({ state: 'downloading', progress: { value: 0.4 } }), 40);
  assert.equal(projection.activeStageFor('awaiting_health_check'), 2);
  assert.equal(projection.isActive('checking', 'update_page'), true);
  assert.equal(projection.isActive('checking', 'panel'), false);
});

test('managed update projection reconciles committed, staged, and lost transactions', () => {
  const base = {
    state: 'awaiting_health',
    currentVersion: '2.2.1',
    latestVersion: '2.2.2',
    transactionId: 'tx-1'
  };
  const committed = projection.reconcile(base, {
    state: 'committed',
    targetVersion: '2.2.2'
  });
  assert.equal(committed.action, 'reload_tabs');
  assert.equal(committed.state.state, 'committed');
  assert.equal(committed.state.transactionId, '');

  const staged = projection.reconcile(base, { state: 'staged', id: 'tx-2' });
  assert.equal(staged.action, 'retry_install');
  assert.equal(staged.state.state, 'staged');
  assert.equal(staged.state.transactionId, 'tx-2');

  const lost = projection.reconcile(base, null);
  assert.equal(lost.action, 'none');
  assert.equal(lost.state.state, 'failed');
  assert.equal(lost.state.code, 'update_transaction_lost');
});
