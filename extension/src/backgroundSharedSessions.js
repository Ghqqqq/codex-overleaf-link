(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafSharedSessionsBackground = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MESSAGE = 'codex-overleaf/shared-sessions-v1';
  const LOCK_PORT = 'codex-overleaf/shared-session-lock-v1';
  const CHANGE_KEY = 'codex-overleaf-shared-sessions-changed-v1';
  const HOSTS = ['overleaf.com', 'www.overleaf.com', 'cn.overleaf.com'];
  const META_PREFIX = 'codex-overleaf-scoped-persistence-v1:';
  const MAX_BYTES = 8 * 1024 * 1024;
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
  const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const failure = (code, message) => Object.assign(new Error(message), { code });
  function part(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0\r\n]/.test(value))
      throw failure('shared_store_scope_invalid', 'The shared session identity is invalid.');
    return value;
  }
  function scope(input) {
    return { accountScopeId: part(input?.accountScopeId), projectId: typeof input?.projectId === 'string' ? input.projectId : '' };
  }
  function keyFor(kind, value) {
    return kind === 'preferences' ? 'preferences'
      : 'state:' + encodeURIComponent(value.accountScopeId);
  }
  function metaKey(value) {
    return META_PREFIX + encodeURIComponent(value.accountScopeId) + ':' + encodeURIComponent(value.projectId);
  }

  // Three-way merge preserves changes made by another tab to untouched fields.
  // Conflicting edits fail closed; removed records are never silently revived.
  function mergeValue(base, current, incoming, field = '') {
    if (equal(incoming, base)) return clone(current);
    if (equal(current, base) || equal(current, incoming)) return clone(incoming);
    if (field === 'updatedAt' || field === 'lastActivityAt')
      return (Date.parse(current) || 0) >= (Date.parse(incoming) || 0) ? current : incoming;
    if (Array.isArray(base) && Array.isArray(current) && Array.isArray(incoming)) {
      if (['runs', 'pendingInputs'].includes(field)
        && [base, current, incoming].every(items => items.every(item => item && typeof item.id === 'string')
          && new Set(items.map(item => item.id)).size === items.length)) {
        const before = new Map(base.map(item => [item.id, item]));
        const latest = new Map(current.map(item => [item.id, item]));
        const proposed = new Map(incoming.map(item => [item.id, item]));
        const ids = [...current.map(item => item.id), ...incoming.map(item => item.id).filter(id => !latest.has(id))];
        return ids.map(id => mergeValue(before.get(id), latest.get(id), proposed.get(id)))
          .filter(item => item !== undefined);
      }
      const extendsBase = items => items.length >= base.length && base.every((item, i) => equal(item, items[i]));
      if (extendsBase(current) && extendsBase(incoming)) {
        const result = clone(current), seen = new Set(result.map(item => JSON.stringify(item)));
        for (const item of incoming.slice(base.length)) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) { result.push(clone(item)); seen.add(key); }
        }
        return result;
      }
    }
    if (base && current && incoming && !Array.isArray(base) && !Array.isArray(current) && !Array.isArray(incoming)
      && [base, current, incoming].every(value => typeof value === 'object')) {
      const result = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)])) {
        if (key === 'sharedRevision') continue;
        const value = mergeValue(base[key], current[key], incoming[key], key);
        if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
      }
      return result;
    }
    throw failure('shared_session_conflict', 'The same session was edited in another tab. Refresh its history before retrying; the local draft was kept.');
  }

  function createService(options = {}) {
    const chromeApi = options.chromeApi, idb = options.indexedDB, ranges = options.IDBKeyRange;
    const locks = new Map(), queues = new Map();
    // Account-wide writes serialize cross-project clears and shared preference saves.
    // IndexedDB transactions still provide the atomic boundary for session batches.
    let opening;
    function openDb() {
      if (!opening) opening = new Promise((resolve, reject) => {
        const request = idb.open('codex-overleaf-shared-sessions', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          const sessions = db.createObjectStore('sessions', { keyPath: ['accountScopeId', 'id'] });
          sessions.createIndex('account', 'accountScopeId');
          sessions.createIndex('project', ['accountScopeId', 'projectId']);
          db.createObjectStore('tombstones', { keyPath: ['accountScopeId', 'id'] });
          db.createObjectStore('migrations', { keyPath: ['accountScopeId', 'origin'] });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { opening = null; reject(request.error); };
      });
      return opening;
    }
    const readRequest = request => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const finished = tx => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error || failure('shared_store_transaction_failed', 'The shared session transaction failed.'));
    });
    async function readOne(store, key) {
      const db = await openDb();
      return readRequest(db.transaction(store, 'readonly').objectStore(store).get(key));
    }
    function senderOrigin(sender) {
      const url = new URL(sender?.url || sender?.tab?.url || '');
      if (sender?.id !== chromeApi.runtime.id || !sender.tab || (sender.frameId != null && sender.frameId !== 0)
        || url.protocol !== 'https:' || !HOSTS.includes(url.hostname) || !/^\/project(?:\/|$)/.test(url.pathname))
        throw failure('forbidden_sender', 'Shared sessions require an authorized Overleaf project page.');
      return url.origin;
    }
    function ensureLock(message, value, sender) {
      const held = locks.get(keyFor('state', value));
      if (!held || held.disconnected || held.token !== message.lockToken || held.tabId !== sender.tab.id)
        throw failure('storage_lock_lost', 'The shared persistence lock was lost.');
    }
    async function notify(value, clientId) {
      // A missed refresh notification must not turn a committed write into a failure.
      await chromeApi.storage.local.set({ [CHANGE_KEY]: {
        accountScopeId: value.accountScopeId, projectId: value.projectId,
        clientId, nonce: crypto.randomUUID(), at: Date.now()
      } }).catch(() => {});
    }
    async function list(value, after = '') {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const result = []; let bytes = 0, last = after;
        const cursor = db.transaction('sessions', 'readonly').objectStore('sessions')
          .openCursor(ranges.bound([value.accountScopeId, after], [value.accountScopeId, '\uffff'], Boolean(after), false));
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) { resolve({ records: result, next: '' }); return; }
          const stored = item.value;
          if (value.projectId && stored.projectId !== value.projectId) { item.continue(); return; }
          const record = { ...stored.record, sharedRevision: stored.revision };
          const size = JSON.stringify(record).length * 2;
          if (result.length && (result.length >= 8 || bytes + size > MAX_BYTES)) {
            resolve({ records: result, next: last }); return;
          }
          result.push(record); bytes += size; last = stored.id; item.continue();
        };
      });
    }
    async function legacyDeleted(record) {
      const key = 'codexOverleafSessionTombstone:v2:' + encodeURIComponent(record.projectId) + ':' + encodeURIComponent(record.id);
      const meta = metaKey(record);
      const stored = await chromeApi.storage.local.get([key, meta, 'codexOverleafSessionTombstones']);
      return Boolean(stored[key] || stored[meta]?.sessionTombstones?.[record.id]
        || stored.codexOverleafSessionTombstones?.[record.projectId]?.includes(record.id));
    }
    function recoveryCopy(record, origin) {
      const suffix = origin.replace(/^https:\/\//, '').replace(/\W/g, '-');
      return { ...record, id: record.id.slice(0, 200) + ':recovered:' + suffix, codexThreadId: '', pendingInputs: [],
        titleSource: 'manual', title: (record.title || 'Recovered session') + ' [' + suffix + ']',
        runs: (record.runs || []).map(run => ({ ...run, forkSnapshot: true, codexThreadId: '',
          status: run.status === 'running' ? 'interrupted' : run.status,
          undoOperations: [], undoBaseFiles: [], undoExpectedFiles: [], undoTrackedChanges: [],
          appliedOperations: [], trackedChangeCaptures: [], undoStatus: '' })) };
    }
    async function writeMany(message, value, importing, origin, sender) {
      const entries = (importing ? [{ record: message.record }] : message.entries || [])
        .map(entry => ({ record: clone(entry.record), base: clone(entry.base) }));
      if (JSON.stringify(entries).length * 2 > MAX_BYTES * 3)
        throw failure('shared_session_too_large', 'The session batch exceeds the shared storage transfer limit.');
      for (const { record, base } of entries) {
        if (!record || record.accountScopeId !== value.accountScopeId || record.projectId !== value.projectId)
          throw failure('shared_store_scope_mismatch', 'The session does not belong to the captured account and project.');
        part(record.id); part(record.projectId);
        delete record.sharedRevision;
        if (base && (base.id !== record.id || base.accountScopeId !== value.accountScopeId || base.projectId !== value.projectId))
          throw failure('shared_store_scope_mismatch', 'The session baseline belongs to a different scope.');
      }
      if (importing && await legacyDeleted(entries[0].record)) return [];
      ensureLock(message, value, sender);
      const db = await openDb();
      // Recheck after opening the database; a disconnected owner cannot commit.
      ensureLock(message, value, sender);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['sessions', 'tombstones', 'migrations'], 'readwrite');
        const store = tx.objectStore('sessions'), deleted = tx.objectStore('tombstones');
        const results = []; let caught;
        const abort = error => { caught = error; tx.abort(); };
        tx.oncomplete = () => resolve(results);
        tx.onabort = tx.onerror = () => reject(caught || tx.error || failure('shared_store_write_failed', 'The session could not be saved.'));
        const marker = tx.objectStore('migrations').get([value.accountScopeId, '*']);
        marker.onsuccess = () => {
          for (const entry of entries) {
            if (marker.result?.clearedAt && (importing || (Date.parse(entry.record.createdAt) || 0) <= marker.result.clearedAt)) {
              if (importing) continue;
              abort(failure('shared_session_deleted', 'This history was cleared and cannot be restored by a stale tab.'));
              return;
            }
            putAt(entry.record, entry.base);
          }
        };
        function putAt(candidate, base, copy = false) {
          const key = [value.accountScopeId, candidate.id];
          const tombstone = deleted.get(key);
          tombstone.onsuccess = () => {
            if (tombstone.result) {
              if (importing) return;
              abort(failure('shared_session_deleted', 'This session was deleted in another tab.')); return;
            }
            const request = store.get(key);
            request.onsuccess = () => {
              try {
                const existing = request.result;
                if (existing && existing.projectId !== candidate.projectId)
                  throw failure('shared_store_scope_mismatch', 'Session identity conflicts with another project.');
                let next = candidate;
                if (importing && existing) {
                  if (equal(existing.record, candidate) || copy) {
                    results.push({ ...existing.record, sharedRevision: existing.revision }); return;
                  }
                  putAt(recoveryCopy(candidate, origin), null, true); return;
                }
                if (existing) {
                  if (!base) throw failure('shared_session_conflict', 'Reload the session before updating existing history.');
                  // Keep the established first-durable-review-decision policy.
                  const reviewed = options.mergeSessionReviewState?.(candidate, existing.record, message.reviewRunIds || []) || candidate;
                  next = mergeValue(base, existing.record, reviewed);
                } else if (base && !importing) {
                  throw failure('shared_session_deleted', 'The session no longer exists.');
                }
                const revision = (existing?.revision || 0) + 1;
                store.put({ accountScopeId: value.accountScopeId, projectId: value.projectId,
                  id: next.id, record: next, revision });
                results.push({ ...next, sharedRevision: revision });
              } catch (error) { abort(error); }
            };
          };
        }
      });
    }
    async function erase(value, id, all, message, sender) {
      const db = await openDb();
      ensureLock(message, value, sender);
      const tx = db.transaction(['sessions', 'tombstones', 'migrations'], 'readwrite');
      const done = finished(tx), sessions = tx.objectStore('sessions'), tombstones = tx.objectStore('tombstones');
      if (id) {
        const request = sessions.get([value.accountScopeId, id]);
        request.onsuccess = () => {
          const existing = request.result;
          if (existing && value.projectId && existing.projectId !== value.projectId) { tx.abort(); return; }
          tombstones.put({ accountScopeId: value.accountScopeId, id, deletedAt: Date.now() });
          sessions.delete([value.accountScopeId, id]);
        };
      } else {
        const cursor = sessions.index('account').openCursor(ranges.only(value.accountScopeId));
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (all || item.value.projectId === value.projectId) {
            tombstones.put({ accountScopeId: value.accountScopeId, id: item.value.id, deletedAt: Date.now() });
            item.delete();
          }
          item.continue();
        };
        if (all) tx.objectStore('migrations').put({ accountScopeId: value.accountScopeId, origin: '*', clearedAt: Date.now() });
      }
      await done;
    }
    async function handle(message, sender) {
      const origin = senderOrigin(sender), value = scope(message.scope);
      const method = message.method;
      if (method === 'list') return list(value, typeof message.after === 'string' ? message.after : '');
      if (method === 'get') {
        const record = await readOne('sessions', [value.accountScopeId, part(message.id)]);
        return record && (!value.projectId || value.projectId === record.projectId)
          ? { ...record.record, sharedRevision: record.revision } : null;
      }
      if (method === 'migration-status') {
        const cleared = await readOne('migrations', [value.accountScopeId, '*']);
        return cleared?.clearedAt ? { complete: true, clearedAt: cleared.clearedAt }
          : await readOne('migrations', [value.accountScopeId, origin]) || { complete: false };
      }
      if (method === 'migration-complete') {
        ensureLock(message, value, sender);
        const db = await openDb(), tx = db.transaction('migrations', 'readwrite'), done = finished(tx);
        tx.objectStore('migrations').put({ ...value, origin, complete: true, at: Date.now() });
        await done; return { complete: true };
      }
      if (method === 'put' || method === 'import') {
        const result = await writeMany(message, value, method === 'import', origin, sender);
        if (result.length) await notify(value, message.clientId);
        return result;
      }
      if (method === 'delete' || method === 'clear-project' || method === 'clear-account') {
        if (method === 'clear-project') part(value.projectId);
        await erase(value, method === 'delete' ? part(message.id) : '', method === 'clear-account', message, sender);
        await notify(value, message.clientId); return true;
      }
      if (method === 'meta-read' || method === 'meta-write') {
        const key = metaKey(value);
        if (method === 'meta-read') return (await chromeApi.storage.local.get(key))[key] || {};
        const held = locks.get(keyFor('state', value));
        if (!held || held.token !== message.lockToken || held.tabId !== sender.tab.id)
          throw failure('storage_lock_lost', 'The shared persistence lock was lost.');
        await chromeApi.storage.local.set({ [key]: message.meta }); return message.meta;
      }
      throw failure('shared_store_method_invalid', 'Unsupported shared session operation.');
    }
    function connect(port) {
      if (port.name !== LOCK_PORT) return;
      try { senderOrigin(port.sender); } catch (_error) { port.disconnect(); return; }
      let heldKey = '', job = null, closed = false;
      function pump(key) {
        if (locks.has(key)) return;
        const queue = queues.get(key);
        while (queue?.length) {
          const next = queue.shift();
          if (next.closed()) continue;
          const token = crypto.randomUUID();
          const held = { token, tabId: next.tabId, port: next.port, inFlight: 0, disconnected: false,
            release() {
              if (locks.get(key) !== held) return;
              locks.delete(key); pump(key);
            }
          };
          locks.set(key, held);
          next.grant(token); return;
        }
        queues.delete(key);
      }
      port.onMessage.addListener(message => {
        if (message?.type === 'ping') { port.postMessage({ type: 'pong' }); return; }
        if (message?.type !== 'acquire' || job) return;
        try {
          const value = scope(message.scope), kind = message.kind === 'preferences' ? 'preferences' : 'state';
          heldKey = keyFor(kind, value);
          job = { port, tabId: port.sender.tab.id, closed: () => closed, grant: token => port.postMessage({ type: 'granted', token }) };
          if (!queues.has(heldKey)) queues.set(heldKey, []);
          queues.get(heldKey).push(job);
          pump(heldKey);
        } catch (_error) { port.disconnect(); }
      });
      port.onDisconnect.addListener(() => {
        closed = true;
        const held = locks.get(heldKey);
        if (held?.port === port) {
          held.disconnected = true;
          if (!held.inFlight) held.release();
        } else if (heldKey) pump(heldKey);
      });
    }
    function install() {
      chromeApi.runtime.onConnect.addListener(connect);
      chromeApi.runtime.onMessage.addListener((message, sender, respond) => {
        if (message?.type !== MESSAGE) return undefined;
        let held;
        try {
          const candidate = locks.get(keyFor('state', scope(message.scope)));
          if (candidate?.token === message.lockToken && candidate.tabId === sender?.tab?.id) {
            held = candidate; held.inFlight += 1;
          }
        } catch (_error) { /* The handler returns the scoped validation error. */ }
        handle(message, sender).then(result => respond({ ok: true, result }),
          error => respond({ ok: false, error: { code: error.code || 'shared_store_unavailable',
            message: error.code ? error.message : 'Shared session storage is unavailable.' } }))
          .finally(() => {
            if (!held) return;
            held.inFlight -= 1;
            if (held.disconnected && !held.inFlight) held.release();
          });
        return true;
      });
    }
    return { install, handle };
  }
  function installBackground(chromeApi) {
    const service = createService({ chromeApi, indexedDB, IDBKeyRange,
      mergeSessionReviewState: globalThis.CodexOverleafStorageRunActions?.mergeSessionReviewState });
    service.install(); return service;
  }
  return { createService, installBackground, mergeValue };
});
