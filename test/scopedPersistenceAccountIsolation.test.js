const assert = require('node:assert/strict');
const test = require('node:test');

const ScopedPersistence = require('../extension/src/content/scopedPersistenceCoordinator');
const BrowserAdapter = require('../extension/src/shared/scopedPersistenceBrowserAdapter');

function createTransactionHarness() {
  const calls = [];
  let active = null;
  return {
    calls,
    Transaction: {
      createBrowserAdapter() {
        return {};
      },
      createCoordinator() {
        return {
          async beginHydration(scope) {
            active = { ...scope, generation: (active?.generation || 0) + 1 };
            calls.push({ type: 'hydrate', scope: { ...scope } });
            return active;
          },
          isCurrent(view) {
            return view === active;
          },
          async captureCommitView(scope) {
            calls.push({ type: 'capture', scope: { ...scope } });
            return { ...scope };
          },
          async commit(view, action) {
            calls.push({ type: 'commit', scope: { ...view } });
            await action({});
            return { ok: true };
          }
        };
      }
    }
  };
}

test('account identity changes invalidate the previous scope before the next commit', async () => {
  const harness = createTransactionHarness();
  let accountScopeId = 'account-a';
  const controller = ScopedPersistence.createController({
    Transaction: harness.Transaction,
    sessionStorage: null,
    getAccountScopeId: () => accountScopeId
  });

  await controller.beginHydration('project-1');
  accountScopeId = 'account-b';
  let writes = 0;
  const result = await controller.commit('project-1', {}, async () => {
    writes += 1;
  });

  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.deepEqual(
    harness.calls.filter(call => call.type === 'hydrate').map(call => call.scope.accountScopeId),
    ['account-a', 'account-b']
  );
  assert.equal(
    harness.calls.findLast(call => call.type === 'commit').scope.accountScopeId,
    'account-b'
  );
});

test('missing account identity cannot commit through a shared unavailable scope', async () => {
  const harness = createTransactionHarness();
  let accountScopeId = 'account-a';
  const controller = ScopedPersistence.createController({
    Transaction: harness.Transaction,
    sessionStorage: null,
    getAccountScopeId: () => accountScopeId
  });

  await controller.beginHydration('project-1');
  accountScopeId = '';
  let writes = 0;
  const result = await controller.commit('project-1', {}, async () => {
    writes += 1;
  });

  assert.deepEqual(result, { ok: false, reason: 'account_scope_unavailable' });
  assert.equal(writes, 0);
  assert.equal(
    harness.calls.filter(call => call.type === 'commit').length,
    0
  );
});

test('browser persistence adapter rejects an unscoped durable key', () => {
  assert.throws(
    () => BrowserAdapter.scopeKey({ accountScopeId: '', projectId: 'project-1' }),
    error => error?.code === 'account_scope_unavailable'
  );
});
