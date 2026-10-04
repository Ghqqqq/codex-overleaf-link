'use strict';
// Deterministic IndexedDB API substitute for the exact operations used here.
// Guards, keys, filtering and erase code remain in the production modules.
// Transactions serialize; readwrite changes commit atomically on completion.
const clone = value => value === undefined ? undefined : structuredClone(value);
const compare = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const d = compare(a[i], b[i]); if (d) return d; }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};
const keyValue = (value, keyPath) => Array.isArray(keyPath) ? keyPath.map(key => value[key]) : value[keyPath];
function createMemoryIdb() {
  const databases = new Map();
  const changes = [];
  const IDBKeyRange = {
    only: value => ({ includes: key => compare(key, value) === 0 }),
    bound: (lower, upper, lowerOpen, upperOpen) => ({ includes: key => {
      const lo = compare(key, lower), hi = compare(key, upper);
      return (lowerOpen ? lo > 0 : lo >= 0) && (upperOpen ? hi < 0 : hi <= 0);
    } })
  };
  const matches = (range, key) => !range || (range.includes ? range.includes(key) : compare(range, key) === 0);
  function database(name) {
    if (databases.has(name)) return databases.get(name);
    const stores = new Map(); let tail = Promise.resolve();
    const db = {
      objectStoreNames: { contains: key => stores.has(key) },
      createObjectStore(key, options) {
        const config = { keyPath: options.keyPath, indexes: new Map(), data: new Map() };
        stores.set(key, config);
        return { createIndex: (index, keyPath) => config.indexes.set(index, keyPath) };
      },
      transaction(storeNames, mode) {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const ready = tail; let release, pending = 0, ended = false, local;
        tail = new Promise(resolve => { release = resolve; });
        const writes = [];
        const tx = { error: null, objectStore(storeName) {
          if (!names.includes(storeName)) throw new Error('Store outside transaction: ' + storeName);
          const config = stores.get(storeName);
          const run = (operation, existingRequest) => {
            const request = existingRequest || {}; pending++;
            ready.then(() => setImmediate(() => {
              if (ended) return;
              if (!local) local = new Map(names.map(name => [name, new Map([...stores.get(name).data].map(([key, value]) => [key, clone(value)]))]));
              try {
                request.result = operation(local.get(storeName));
                request.onsuccess?.({ target: request });
              } catch (error) { request.error = tx.error = error; request.onerror?.({ target: request }); tx.abort(); }
              pending--; finish();
            }));
            return request;
          };
          function cursor(range, indexName) {
            let values, offset = 0; const request = {};
            const next = () => run(store => {
              values ||= [...store.values()].filter(value => matches(range, keyValue(value, indexName ? config.indexes.get(indexName) : config.keyPath)))
                .sort((a, b) => compare(keyValue(a, config.keyPath), keyValue(b, config.keyPath)));
              const value = values[offset++];
              if (!value) return null;
              return { value: clone(value), key: keyValue(value, config.keyPath),
                continue: next, delete: () => run(current => {
                  const key = keyValue(value, config.keyPath); current.delete(JSON.stringify(key));
                  writes.push({ database: name, store: storeName, method: 'delete', key });
                }) };
            }, request);
            next(); return request;
          }
          return {
            get: key => run(store => clone(store.get(JSON.stringify(key)))),
            getAll: range => run(store => [...store.values()].filter(value => matches(range, keyValue(value, config.keyPath))).map(clone)),
            put: value => run(store => {
              const key = keyValue(value, config.keyPath); store.set(JSON.stringify(key), clone(value));
              writes.push({ database: name, store: storeName, method: 'put', key, value: clone(value) }); return key;
            }),
            delete: key => run(store => { store.delete(JSON.stringify(key)); writes.push({ database: name, store: storeName, method: 'delete', key }); }),
            clear: () => run(store => { store.clear(); writes.push({ database: name, store: storeName, method: 'clear' }); }),
            openCursor: range => cursor(range),
            index: indexName => ({
              getAll: range => run(store => [...store.values()].filter(value => matches(range, keyValue(value, config.indexes.get(indexName)))).map(clone)),
              openCursor: range => cursor(range, indexName)
            })
          };
        }, abort() {
          if (ended) return; ended = true;
          setImmediate(() => { tx.onabort?.({ target: tx }); release(); });
        } };
        function finish() {
          if (pending || ended) return; ended = true;
          setImmediate(() => {
            if (mode === 'readwrite') {
              for (const [key, values] of local) stores.get(key).data = values;
              changes.push(...writes);
            }
            tx.oncomplete?.({ target: tx }); release();
          });
        }
        return tx;
      },
      seed(store, value) { const config = stores.get(store); config.data.set(JSON.stringify(keyValue(value, config.keyPath)), clone(value)); },
      values(store) { return [...(stores.get(store)?.data.values() || [])].map(clone); }
    };
    databases.set(name, db); return db;
  }
  return { changes, databases, IDBKeyRange,
    indexedDB: { open(name) {
      const request = {}; const existed = databases.has(name);
      setImmediate(() => { request.result = database(name);
        if (!existed) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request }); });
      return request;
    } }
  };
}
module.exports = { createMemoryIdb };
