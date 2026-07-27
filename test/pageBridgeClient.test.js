const assert = require('node:assert/strict');
const test = require('node:test');

const PageBridgeClient = require('../extension/src/content/pageBridgeClient');
const PageRpcContract = require('../extension/src/shared/pageRpcContract');

test('page bridge client keeps document mutations single-attempt and cancellable', async () => {
  const listeners = new Set();
  const posted = [];
  const windowRef = {
    location: { origin: 'https://www.overleaf.com' },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    postMessage(message) { posted.push(message); },
    setTimeout() { return 1; },
    clearTimeout() {},
    queueMicrotask(fn) { globalThis.queueMicrotask(fn); }
  };
  const client = PageBridgeClient.create({
    window: windowRef,
    document: {},
    chromeApi: { runtime: { getURL: value => value } },
    crypto: { randomUUID: () => 'rpc-1' },
    contract: PageRpcContract,
    compatibility: { BUILD_TARGET_VERSION: '2.2.1' },
    isCancellationRequested: () => true
  });
  await assert.rejects(
    client.send(
      'applyOperations',
      {},
      PageRpcContract.resolveDispatchPolicy('applyOperations', { writeback: 30000 })
    ),
    error => error?.code === 'codex_cancelled'
  );
  assert.equal(posted.length, 1);
  assert.equal(posted[0].method, 'applyOperations');
  assert.equal(listeners.size, 0);
});

test('page bridge injection catalog preserves page-world dependency order', () => {
  const scripts = PageBridgeClient.PAGE_WORLD_SCRIPTS.map(entry => entry[0]);
  assert.ok(scripts.indexOf('src/page/trackedChangesLifecycle.js') > -1);
  assert.ok(
    scripts.indexOf('src/page/trackedChangesLifecycle.js')
      < scripts.indexOf('src/page/writebackRouter.js')
  );
  assert.ok(
    scripts.indexOf('src/page/pageBridgeCapability.js')
      < scripts.indexOf('src/pageBridge.js')
  );
  assert.deepEqual(
    PageBridgeClient.OPTIONAL_OT_SCRIPTS.map(entry => entry[0]),
    ['src/shared/otText.js', 'src/page/overleafRealtimeObserver.js']
  );
});
