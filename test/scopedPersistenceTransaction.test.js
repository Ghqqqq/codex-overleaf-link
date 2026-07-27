const test = require('node:test');
const assert = require('node:assert/strict');

const Transaction = require('../extension/src/shared/scopedPersistenceTransaction.js');

function createAdapter() {
  const meta = new Map();
  const chains = new Map();
  const key = scope => `${scope.accountScopeId}:${scope.projectId}`;
  return {
    async read(scope) {
      return meta.get(key(scope)) || { revision: 0 };
    },
    async write(scope, value) {
      meta.set(key(scope), { ...value });
    },
    withLock(scope, work) {
      const id = key(scope);
      const previous = chains.get(id) || Promise.resolve();
      const current = previous.then(work, work);
      chains.set(id, current);
      return current.finally(() => {
        if (chains.get(id) === current) chains.delete(id);
      });
    }
  };
}

test('late hydration is rejected after the active project changes', async () => {
  const coordinator = Transaction.createCoordinator({ adapter: createAdapter(), writerId: 'tab-a' });
  const first = coordinator.beginHydration({ accountScopeId: 'account', projectId: 'one' });
  const second = coordinator.beginHydration({ accountScopeId: 'account', projectId: 'two' });
  const [firstView, secondView] = await Promise.all([first, second]);
  assert.equal(coordinator.isCurrent(firstView), false);
  assert.equal(coordinator.isCurrent(secondView), true);
});

test('same-scope commits are serialized and revisions increase monotonically', async () => {
  const adapter = createAdapter();
  const left = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const right = Transaction.createCoordinator({ adapter, writerId: 'tab-b' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const leftView = await left.beginHydration(scope);
  const rightView = await right.beginHydration(scope);
  const order = [];
  const results = await Promise.all([
    left.commit(leftView, async () => {
      order.push('left-start');
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('left-end');
    }, { rebase: true }),
    right.commit(rightView, async () => order.push('right'), { rebase: true })
  ]);
  assert.deepEqual(order, ['left-start', 'left-end', 'right']);
  assert.equal(results[0].revision, 1);
  assert.equal(results[1].revision, 2);
  assert.equal(results[1].rebased, true);
});

test('a stale view cannot begin a durable commit', async () => {
  const coordinator = Transaction.createCoordinator({ adapter: createAdapter(), writerId: 'tab-a' });
  const oldView = await coordinator.beginHydration({ accountScopeId: 'account', projectId: 'one' });
  await coordinator.beginHydration({ accountScopeId: 'account', projectId: 'two' });
  let called = false;
  const result = await coordinator.commit(oldView, async () => { called = true; }, { rebase: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_view');
  assert.equal(called, false);
});

test('a commit invalidated while waiting for metadata cannot run its action', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const view = await coordinator.beginHydration({
    accountScopeId: 'account',
    projectId: 'paper'
  });
  const originalRead = adapter.read;
  let releaseRead;
  let signalRead;
  const readStarted = new Promise(resolve => { signalRead = resolve; });
  adapter.read = async scope => {
    signalRead();
    await new Promise(resolve => { releaseRead = resolve; });
    return originalRead(scope);
  };
  let called = false;
  const pending = coordinator.commit(view, async () => {
    called = true;
  }, { rebase: true });

  await readStarted;
  coordinator.invalidate();
  releaseRead();
  const result = await pending;

  assert.deepEqual(result, { ok: false, reason: 'stale_view' });
  assert.equal(called, false);
});

test('a commit invalidated after writing its fence completes its paired action', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const view = await coordinator.beginHydration({
    accountScopeId: 'account',
    projectId: 'paper'
  });
  const originalWrite = adapter.write;
  let releaseWrite;
  let signalWrite;
  const writeStarted = new Promise(resolve => { signalWrite = resolve; });
  adapter.write = async (scope, value) => {
    signalWrite();
    await new Promise(resolve => { releaseWrite = resolve; });
    return originalWrite(scope, value);
  };
  let called = false;
  const pending = coordinator.commit(view, async () => {
    called = true;
  }, { rebase: true });

  await writeStarted;
  coordinator.invalidate();
  releaseWrite();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.superseded, true);
  assert.equal(called, true);
});

test('queue claims require item, owner, and revision equality', () => {
  const claim = Transaction.createQueueClaim({
    itemId: 'queued-1',
    ownerId: 'tab-a',
    queueRevision: 7
  });
  assert.equal(Transaction.isClaimCurrent(claim, {
    itemId: 'queued-1', ownerId: 'tab-a', queueRevision: 7
  }), true);
  assert.equal(Transaction.isClaimCurrent(claim, {
    itemId: 'queued-1', ownerId: 'tab-b', queueRevision: 7
  }), false);
});

test('tombstones are deduplicated and bounded newest-first', () => {
  const merged = Transaction.mergeTombstones({
    old: '2026-01-01T00:00:00.000Z'
  }, ['new-a', 'new-b'], 2);
  assert.equal(Object.keys(merged).length, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'old'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'new-a'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'new-b'), true);
});

test('queue claims use an independent CAS revision and reject a competing tab', async () => {
  const adapter = createAdapter();
  const left = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const right = Transaction.createCoordinator({ adapter, writerId: 'tab-b' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const leftView = await left.beginHydration(scope);
  const rightView = await right.beginHydration(scope);
  const first = await left.commit(leftView, async () => 'claimed', {
    rebase: true,
    queueMutation: { type: 'claim', sessionId: 'session', itemId: 'queued-1' }
  });
  const second = await right.commit(rightView, async () => 'should-not-run', {
    rebase: true,
    queueMutation: { type: 'claim', sessionId: 'session', itemId: 'queued-1' }
  });

  assert.equal(first.ok, true);
  assert.equal(first.queueRevision, 1);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'queue_revision_conflict');
});

test('queue removal creates a durable tombstone and releases its claim', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  let view = await coordinator.beginHydration(scope);
  await coordinator.commit(view, async () => {}, {
    queueMutation: {
      type: 'claim',
      sessionId: 'session',
      itemId: 'queued-1',
      claimToken: 'claim-1'
    }
  });
  view = coordinator.getActiveView();
  const removed = await coordinator.commit(view, async context => context.nextMeta, {
    queueMutation: {
      type: 'remove',
      sessionId: 'session',
      itemId: 'queued-1',
      claimToken: 'claim-1'
    }
  });

  assert.equal(removed.ok, true);
  assert.equal(removed.value.queueClaims['queued-1'], undefined);
  assert.ok(removed.value.queueTombstones['queued-1']);
});

test('commit metadata reads fail closed', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const view = await coordinator.beginHydration(scope);
  adapter.read = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(
    coordinator.commit(view, async () => {}),
    /storage unavailable/
  );
});

test('hydration metadata reads fail closed', async () => {
  const adapter = createAdapter();
  adapter.read = async () => {
    throw new Error('storage unavailable');
  };
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  await assert.rejects(
    coordinator.beginHydration({ accountScopeId: 'account', projectId: 'paper' }),
    /storage unavailable/
  );
});

test('metadata is a durable fence before the session action runs', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const view = await coordinator.beginHydration(scope);
  let actionCalled = false;
  adapter.write = async () => {
    throw new Error('metadata unavailable');
  };

  await assert.rejects(
    coordinator.commit(view, async () => {
      actionCalled = true;
    }, {
      queueMutation: {
        type: 'claim',
        sessionId: 'session',
        itemId: 'queued-1',
        claimToken: 'claim-1'
      }
    }),
    /metadata unavailable/
  );
  assert.equal(actionCalled, false);
});

test('a failed session action retains the fenced revision for claim recovery', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const view = await coordinator.beginHydration(scope);

  await assert.rejects(
    coordinator.commit(view, async () => {
      throw new Error('session write failed');
    }, {
      queueMutation: {
        type: 'claim',
        sessionId: 'session',
        itemId: 'queued-1',
        claimToken: 'claim-1'
      }
    }),
    /session write failed/
  );

  const recoveryView = coordinator.getActiveView();
  assert.equal(recoveryView.revision, 1);
  assert.equal(recoveryView.queueRevision, 1);
  const released = await coordinator.commit(recoveryView, async () => {}, {
    queueMutation: {
      type: 'release',
      sessionId: 'session',
      itemId: 'queued-1',
      claimToken: 'claim-1'
    }
  });
  assert.equal(released.ok, true);
  assert.equal(released.queueRevision, 2);
});

test('a failed queue removal restores its durable fence and can restore the input', async () => {
  const adapter = createAdapter();
  const coordinator = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  let view = await coordinator.beginHydration(scope);
  await coordinator.commit(view, async () => {}, {
    queueMutation: {
      type: 'claim',
      sessionId: 'session',
      itemId: 'queued-1',
      claimToken: 'claim-1'
    }
  });
  view = coordinator.getActiveView();

  await assert.rejects(
    coordinator.commit(view, async () => {
      throw new Error('session write failed');
    }, {
      queueMutation: {
        type: 'remove',
        sessionId: 'session',
        itemId: 'queued-1',
        claimToken: 'claim-1'
      }
    }),
    /session write failed/
  );

  view = coordinator.getActiveView();
  const restored = await coordinator.commit(view, async context => context.nextMeta, {
    queueMutation: {
      type: 'restore',
      sessionId: 'session',
      itemId: 'queued-1',
      claimToken: 'claim-1'
    }
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.value.queueClaims['queued-1'], undefined);
  assert.equal(restored.value.queueTombstones['queued-1'], undefined);
});

test('queue revision conflict refreshes the active fence for a controlled retry', async () => {
  const adapter = createAdapter();
  const left = Transaction.createCoordinator({ adapter, writerId: 'tab-a' });
  const right = Transaction.createCoordinator({ adapter, writerId: 'tab-b' });
  const scope = { accountScopeId: 'account', projectId: 'paper' };
  const leftView = await left.beginHydration(scope);
  const rightView = await right.beginHydration(scope);

  await left.commit(leftView, async () => {}, {
    queueMutation: { type: 'enqueue', sessionId: 'session', itemId: 'queued-a' }
  });
  const conflicted = await right.commit(rightView, async () => {}, {
    rebase: true,
    queueMutation: { type: 'transition', sessionId: 'session' }
  });
  assert.equal(conflicted.reason, 'queue_revision_conflict');

  const refreshed = right.getActiveView();
  assert.equal(refreshed.revision, conflicted.actualStateRevision);
  assert.equal(refreshed.queueRevision, conflicted.actualRevision);
  const retried = await right.commit(refreshed, async () => 'retried', {
    queueMutation: { type: 'transition', sessionId: 'session' }
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.value, 'retried');
});
