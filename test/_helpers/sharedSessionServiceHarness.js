'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const BridgeModule = require(path.join(root, 'extension/src/shared/sharedSessionBridge.js'));
const QueuePolicy = require(path.join(root, 'extension/src/shared/scopedPersistenceQueuePolicy.js'));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
async function drain(count = 25) { for (let i = 0; i < count; i++) await flush(); }
function event() {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f),
    emit: (...args) => [...listeners].map(f => f(...args)), clear: () => listeners.clear() };
}

// Narrow synthetic IndexedDB: async requests, serialized transactions, cursor
// ordering, atomic commit/abort. It does not model browser quota or corruption.
function memoryDb() {
  const stores = new Map(['sessions','tombstones','migrations'].map(name => [name, new Map()]));
  const key = (name, value) => name === 'migrations' ? [value.accountScopeId, value.origin] : [value.accountScopeId, value.id];
  const encode = value => JSON.stringify(value);
  const compare = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue; return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  };
  let tail = Promise.resolve();
  const db = {
    transaction(names, mode) {
      names = Array.isArray(names) ? names : [names];
      let release, pending = 0, ended = false, local;
      const ready = tail; tail = new Promise(r => { release = r; });
      const tx = { error: null,
        abort() {
          if (ended) return; ended = true;
          setImmediate(() => { tx.onabort?.({ target: tx }); release(); });
        },
        objectStore(name) {
          assert.ok(names.includes(name));
          const request = action => {
            const req = {}; enqueue(req, action); return req;
          };
          function enqueue(req, action) {
            pending++;
            ready.then(() => setImmediate(() => {
              if (ended) return;
              if (!local) local = new Map(names.map(n => [n, new Map(stores.get(n))]));
              try { req.result = action(local.get(name)); req.onsuccess?.({ target: req }); }
              catch (error) { tx.error = error; req.error = error; req.onerror?.({ target: req }); tx.abort(); }
              pending--; finish();
            }));
          }
          function cursor(range, index = '') {
            const req = {}; let records, position = 0;
            const next = () => enqueue(req, values => {
              if (!records) records = [...values.values()].filter(value => {
                const candidate = index === 'account' ? value.accountScopeId : key(name, value);
                if (range?.only !== undefined) return encode(candidate) === encode(range.only);
                const low = compare(candidate, range.lower), high = compare(candidate, range.upper);
                return (low > 0 || (low === 0 && !range.lowerOpen)) && (high < 0 || (high === 0 && !range.upperOpen));
              }).sort((a,b) => compare(key(name,a), key(name,b)));
              const value = records[position++];
              return value ? { value: plain(value), continue: next,
                delete() { values.delete(encode(key(name, value))); } } : null;
            });
            next(); return req;
          }
          return {
            get: id => request(values => plain(values.get(encode(id)))),
            put: value => request(values => { const id = key(name, value); values.set(encode(id), plain(value)); return id; }),
            delete: id => request(values => values.delete(encode(id))),
            openCursor: range => cursor(range), index: name => ({ openCursor: range => cursor(range, name) })
          };
        }
      };
      function finish() {
        if (pending || ended) return;
        ended = true;
        setImmediate(() => {
          if (mode === 'readwrite') for (const [name, values] of local) stores.set(name, values);
          tx.oncomplete?.({ target: tx }); release();
        });
      }
      return tx;
    }
  };
  return {
    indexedDB: { open() { const req = {}; setImmediate(() => { req.result = db; req.onsuccess?.({ target: req }); }); return req; } },
    ranges: { bound: (lower, upper, lowerOpen, upperOpen) => ({ lower, upper, lowerOpen, upperOpen }), only: value => ({ only: value }) },
    seed(name, value) { stores.get(name).set(encode(key(name, value)), plain(value)); },
    peek: (name, id) => plain(stores.get(name).get(encode(id)))
  };
}

function createNetwork() {
  const db = memoryDb(), local = {}, messages = [], ports = [], changeEvent = event();
  const onMessage = event(), onConnect = event();
  const holds = [], getGates = [];
  const metaPrefix = 'codex-overleaf-scoped-persistence-v1:';
  const extensionId = 'synthetic-extension-022-027';
  const chromeApi = { runtime: { id: extensionId, onMessage, onConnect }, storage: {
    onChanged: changeEvent,
    local: {
      async get(keys) {
        const gate = getGates.find(g => !g.used && typeof keys === 'string' && keys.startsWith(metaPrefix));
        if (gate) { gate.used = true; gate.entered.resolve(); await gate.release.promise; }
        const selected = keys == null ? Object.keys(local) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(selected.filter(key => Object.hasOwn(local, key)).map(key => [key, plain(local[key])]));
      },
      async remove(key) { delete local[key]; },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: plain(local[key]), newValue: plain(value) }; local[key] = plain(value); }
        changeEvent.emit(changes, 'local');
      }
    }
  } };
  const serviceContext = { module: { exports: {} }, crypto: webcrypto, URL, console,
    require: require('node:module').createRequire(path.join(root, 'extension/src/backgroundSharedSessions.js')) };
  vm.runInNewContext(read('extension/src/backgroundSharedSessions.js'), serviceContext);
  const service = serviceContext.module.exports.createService({ chromeApi, indexedDB: db.indexedDB, IDBKeyRange: db.ranges,
    mergeSessionReviewState: require(path.join(root, 'extension/src/shared/storageRunActions.js')).mergeSessionReviewState });
  service.install();
  async function deliver(envelope) {
    assert.equal(envelope.delivered, false); envelope.delivered = true;
    const results = onMessage.emit(envelope.message, envelope.sender, response => {
      envelope.response = plain(response); envelope.resolve(plain(response));
    });
    assert.deepEqual(results, [true], 'real background install listener must accept message family');
  }
  function client(tabId, account = 'account-one', project = 'project-one') {
    const sender = { id: extensionId, tab: { id: tabId, url: `https://www.overleaf.com/project/${project}` },
      url: `https://www.overleaf.com/project/${project}`, frameId: 0 };
    db.seed('migrations', { accountScopeId: account, origin: 'https://www.overleaf.com', complete: true });
    const runtime = { id: extensionId, lastError: undefined,
      sendMessage(message) {
        const envelope = { message: plain(message), sender: plain(sender), delivered: false, response: null };
        const promise = new Promise(resolve => { envelope.resolve = resolve; }); messages.push(envelope);
        const hold = holds.find(h => !h.used && h.method === message.method && (!h.tabId || h.tabId === tabId));
        if (hold) { hold.used = true; hold.envelope = envelope; hold.entered.resolve(envelope); }
        else void deliver(envelope);
        return promise;
      },
      connect({ name }) {
        const front = { name, onMessage: event(), onDisconnect: event() };
        const back = { name, sender: plain(sender), onMessage: event(), onDisconnect: event() };
        const pair = { front, back, tabId, closed: false };
        const disconnect = () => {
          if (pair.closed) return; pair.closed = true;
          // Explicit modeled ordering, not a claim about Chrome event order.
          back.onDisconnect.emit(); front.onDisconnect.emit();
        };
        front.disconnect = back.disconnect = disconnect;
        front.postMessage = value => { if (pair.closed) throw new Error('synthetic closed port'); queueMicrotask(() => back.onMessage.emit(plain(value))); };
        back.postMessage = value => { if (pair.closed) throw new Error('synthetic closed port'); queueMicrotask(() => front.onMessage.emit(plain(value))); };
        ports.push(pair); onConnect.emit(back); return front;
      }
    };
    const environment = { chrome: { runtime, storage: { onChanged: changeEvent } },
      location: { protocol: 'https:', hostname: 'www.overleaf.com', pathname: `/project/${project}` },
      codexOverleafDeriveAccountScopeId: () => account,
      crypto: { randomUUID: () => `synthetic-client-${tabId}` },
      setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
      setInterval: (...args) => { const timer = setInterval(...args); timer.unref(); return timer; }, clearInterval };
    const bridge = BridgeModule.createBridge(environment);
    const adapterContext = { module: { exports: {} }, require(name) {
      if (name === './sharedSessionBridge') return bridge;
      if (name === './scopedPersistenceQueuePolicy') return QueuePolicy;
      throw new Error('unexpected adapter dependency ' + name);
    } };
    vm.runInNewContext(read('extension/src/shared/scopedPersistenceBrowserAdapter.js'), adapterContext);
    const adapter = adapterContext.module.exports.createBrowserAdapter();
    return { bridge, adapter, environment, sender, scope: { accountScopeId: account, projectId: project },
      disconnect() { const pair = ports.findLast(p => p.tabId === tabId && !p.closed); assert.ok(pair, 'live port required'); pair.front.disconnect(); } };
  }
  return { db, chromeApi, service, local, messages, ports, client, deliver,
    restartBackground() {
      for (const pair of ports) pair.front.disconnect();
      onMessage.clear(); onConnect.clear();
      const replacement = serviceContext.module.exports.createService({ chromeApi, indexedDB: db.indexedDB, IDBKeyRange: db.ranges,
        mergeSessionReviewState: require(path.join(root, 'extension/src/shared/storageRunActions.js')).mergeSessionReviewState });
      replacement.install(); return replacement;
    },
    holdMessage(method, tabId) { const item = { method, tabId, used: false, entered: deferred() }; holds.push(item); return item; },
    holdMetaRead() { const item = { used: false, entered: deferred(), release: deferred() }; getGates.push(item); return item; },
    async notifyExternal(projectId = 'project-one') { await chromeApi.storage.local.set({
      'codex-overleaf-shared-sessions-changed-v1': { accountScopeId: 'account-one', projectId, clientId: 'synthetic-external-store', nonce: 'synthetic' }
    }); },
    meta(scope) { return plain(local[metaPrefix + encodeURIComponent(scope.accountScopeId) + ':' + encodeURIComponent(scope.projectId)] || {}); },
    close() { for (const pair of ports) pair.front.disconnect(); }
  };
}
function clockedViewSync() {
  const timers = [];
  const context = { module: { exports: {} },
    setTimeout(callback) { const timer = { callback, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; } };
  vm.runInNewContext(read('extension/src/content/sharedSessionViewSync.js'), context);
  return { api: context.module.exports,
    async tick() { const timer = timers.find(t => !t.cancelled); assert.ok(timer, 'scheduled passive refresh required'); timer.cancelled = true; timer.callback(); await drain(); },
    pending: () => timers.filter(t => !t.cancelled).length };
}
module.exports = { root, plain, read, deferred, flush, drain, createNetwork, clockedViewSync };
