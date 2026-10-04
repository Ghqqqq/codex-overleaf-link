'use strict';
// Narrow deterministic IndexedDB substitute: serialized transactions, async
// requests, atomic commit/abort. It deliberately does not model browser quota.
function createMemoryDraftDb() {
  const data = new Map();
  let tail = Promise.resolve(), failNextCommit = false;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const db = {
    transaction(names, mode) {
      names = Array.isArray(names) ? names : [names];
      let release, active = false, pending = 0, ended = false, local;
      const ready = tail;
      tail = new Promise(resolve => { release = resolve; });
      const tx = { error: null,
        objectStore(name) {
          if (!names.includes(name)) throw new Error('Store not in transaction: ' + name);
          const run = operation => {
            const request = {}; pending++;
            ready.then(() => setImmediate(() => {
              if (ended) return;
              if (!active) {
                active = true; local = new Map(names.map(key => [key, new Map(data.get(key) || [])]));
              }
              try {
                request.result = clone(operation(local.get(name)));
                request.onsuccess?.({ target: request });
              } catch (error) { tx.error = error; tx.abort(); }
              pending--; finish();
            }));
            return request;
          };
          return {
            get: id => run(store => store.get(id)),
            put: record => run(store => { store.set(record.id, clone(record)); return record.id; }),
            clear: () => run(store => store.clear())
          };
        },
        abort() {
          if (ended) return;
          ended = true; setImmediate(() => { tx.onabort?.({ target: tx }); release(); });
        }
      };
      function finish() {
        if (pending || ended) return;
        ended = true;
        setImmediate(() => {
          if (failNextCommit && mode === 'readwrite') {
            failNextCommit = false; tx.error = new Error('Synthetic IDB commit failure'); tx.onabort?.({ target: tx });
          } else {
            if (mode === 'readwrite') for (const [key, records] of local) data.set(key, records);
            tx.oncomplete?.({ target: tx });
          }
          release();
        });
      }
      return tx;
    }
  };
  return { openDb: async () => db, failNextCommit() { failNextCommit = true; },
    records: () => [...(data.get('artifacts') || new Map()).values()].map(clone) };
}
module.exports = { createMemoryDraftDb };
