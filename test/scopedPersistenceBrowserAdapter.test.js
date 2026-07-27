const assert = require('node:assert/strict');
const test = require('node:test');

const BrowserAdapter = require('../extension/src/shared/scopedPersistenceBrowserAdapter.js');

test('durable transactions fail closed when no cross-realm lock manager exists', async () => {
  const adapter = BrowserAdapter.createBrowserAdapter({
    locksApi: null
  });

  await assert.rejects(
    adapter.withLock(
      { accountScopeId: 'account-1', projectId: 'project-1' },
      async () => 'unsafe-write'
    ),
    error => {
      assert.equal(error.code, 'storage_lock_unavailable');
      return true;
    }
  );
});

test('durable transactions still use the browser lock manager when available', async () => {
  const requests = [];
  const adapter = BrowserAdapter.createBrowserAdapter({
    locksApi: {
      request(name, options, work) {
        requests.push({ name, options });
        return work();
      }
    }
  });

  const result = await adapter.withLock(
    { accountScopeId: 'account-1', projectId: 'project-1' },
    async () => 'committed'
  );

  assert.equal(result, 'committed');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.mode, 'exclusive');
});
