const assert = require('node:assert/strict');
const test = require('node:test');

const Coordinator = require('../extension/src/content/scopedPersistenceCoordinator');

test('detached commits use an isolated transaction and preserve the active scope', async () => {
  const transactions = [];
  const Transaction = {
    createBrowserAdapter() {
      return { kind: 'browser-adapter' };
    },
    createCoordinator({ writerId }) {
      const id = transactions.length + 1;
      const calls = [];
      const transaction = {
        id,
        calls,
        async beginHydration(scope) {
          calls.push({ type: 'hydrate', scope });
          return { scope, generation: id };
        },
        isCurrent(token) {
          return token?.generation === id;
        },
        async captureCommitView(scope, options) {
          calls.push({ type: 'capture', scope, options });
          return { scope, generation: id };
        },
        async commit(token, action, options) {
          calls.push({ type: 'commit', token, options, writerId });
          return action();
        }
      };
      transactions.push(transaction);
      return transaction;
    }
  };
  const controller = Coordinator.createController({
    Transaction,
    chromeApi: {},
    sessionStorage: {
      getItem() {
        return 'writer-a';
      }
    },
    getAccountScopeId: () => 'current-account'
  });

  await controller.beginHydration('current-project');
  const result = await controller.commitDetached(
    'original-project',
    'original-account',
    { rebase: true },
    async () => ({ ok: true, value: 'settled' })
  );

  assert.deepEqual(result, { ok: true, value: 'settled' });
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions[0].calls, [{
    type: 'hydrate',
    scope: {
      accountScopeId: 'current-account',
      projectId: 'current-project'
    }
  }]);
  assert.deepEqual(transactions[1].calls[0], {
    type: 'hydrate',
    scope: {
      accountScopeId: 'original-account',
      projectId: 'original-project'
    }
  });
  assert.deepEqual(transactions[1].calls[1], {
    type: 'capture',
    scope: {
      accountScopeId: 'original-account',
      projectId: 'original-project'
    },
    options: { detached: true }
  });
  assert.equal(transactions[1].calls[2].type, 'commit');
  assert.equal(transactions[1].calls[2].options.rebase, true);
});
