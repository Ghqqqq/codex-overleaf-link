(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SharedSessionBridge', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MESSAGE = 'codex-overleaf/shared-sessions-v1';
  const LOCK_PORT = 'codex-overleaf/shared-session-lock-v1';
  const CHANGE_KEY = 'codex-overleaf-shared-sessions-changed-v1';
  const BASE = Symbol('shared-session-base');
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const clean = record => {
    const result = clone(record);
    if (result) delete result.sharedRevision;
    return result;
  };

  function createBridge(environment = globalThis) {
    const chromeApi = environment.chrome;
    const clientId = environment.crypto?.randomUUID?.() || 'page-' + Date.now() + '-' + Math.random();
    const migrations = new Map(), baselines = new Map(), heldLocks = new Map();
    let legacy, wrapped;
    function enabled() {
      return Boolean(chromeApi?.runtime?.sendMessage && chromeApi?.runtime?.connect
        && environment.location?.protocol === 'https:'
        && ['overleaf.com', 'www.overleaf.com', 'cn.overleaf.com'].includes(environment.location?.hostname)
        && /^\/project(?:\/|$)/.test(environment.location?.pathname || ''));
    }
    function capture(projectId = '', accountScopeId) {
      const current = environment.codexOverleafDeriveAccountScopeId?.();
      if (!current || (accountScopeId && current !== accountScopeId))
        throw failure('account_scope_unavailable', 'A stable matching Overleaf account is required for shared history.');
      return { accountScopeId: current, projectId };
    }
    function assertScope(value) { capture(value.projectId, value.accountScopeId); }
    const cacheKey = (value, id) => value.accountScopeId + ':' + id;
    const lockKey = (kind, value) => kind === 'preferences' ? 'preferences' : 'state:' + value.accountScopeId;
    async function request(method, value, args = {}) {
      assertScope(value);
      const lock = heldLocks.get(lockKey('state', value));
      if (lock?.lost) throw failure('storage_lock_lost', 'The background storage connection was lost.');
      const response = await chromeApi.runtime.sendMessage({
        ...args, type: MESSAGE, method, scope: value, clientId, lockToken: lock?.token || ''
      });
      assertScope(value);
      if (!response?.ok)
        throw failure(response?.error?.code || 'shared_store_unavailable',
          response?.error?.message || 'Shared history is unavailable. Reload the extension and this page.');
      return response.result;
    }

    // Live ports own the locks. Worker/page termination releases them without
    // allowing a stale client to silently fall back to an origin-local lock.
    async function acquire(kind, value, work) {
      assertScope(value);
      const key = lockKey(kind, value), port = chromeApi.runtime.connect({ name: LOCK_PORT });
      let timer, heartbeat, released = false, lock = null, rejectGrant;
      const granted = new Promise((resolve, reject) => {
        rejectGrant = reject;
        port.onMessage.addListener(message => {
          if (message?.type !== 'granted' || lock || released) return;
          clearTimeout(timer);
          lock = { token: message.token, lost: false };
          heldLocks.set(key, lock);
          resolve();
        });
        port.onDisconnect.addListener(() => {
          // Read lastError to consume the runtime's disconnected-port warning.
          void chromeApi.runtime.lastError;
          if (lock) lock.lost = true;
          if (!released) reject(failure('storage_lock_lost', 'The shared history lock disconnected.'));
        });
        timer = environment.setTimeout(() => reject(failure('storage_lock_timeout',
          'Another page is saving history. Retry after it finishes.')), 20000);
      });
      try {
        heartbeat = environment.setInterval(() => {
          try { port.postMessage({ type: 'ping' }); }
          catch (_error) {
            if (lock) lock.lost = true;
            rejectGrant(failure('storage_lock_lost', 'The shared history lock disconnected.'));
          }
        }, 15000);
        port.postMessage({ type: 'acquire', kind, scope: value });
        await granted;
        assertScope(value);
        const result = await work();
        assertScope(value);
        if (lock.lost) throw failure('storage_lock_lost', 'The shared history lock was lost before completion.');
        return result;
      } finally {
        released = true;
        environment.clearTimeout(timer);
        environment.clearInterval(heartbeat);
        if (heldLocks.get(key) === lock) heldLocks.delete(key);
        port.disconnect();
      }
    }
    async function migrate(value) {
      const account = value.accountScopeId;
      if (!migrations.has(account)) {
        const pending = (async () => {
          const status = await request('migration-status', value);
          if (status.complete) return;
          if (!legacy) throw failure('shared_store_unavailable', 'Legacy history storage is not ready.');
          // Read the original site DB once. Only explicitly owned records may
          // cross origins. Unknown-account rows remain untouched for recovery.
          const records = (await legacy.getAllSessions())
            .filter(record => record?.accountScopeId === account && record.projectId && record.id);
          await acquire('state', value, async () => {
            for (const record of records) {
              const recordScope = capture(record.projectId, account);
              await request('import', recordScope, {
                record: legacy.buildSessionRecord(record, { preserveRunActionPayload: true })
              });
            }
            await request('migration-complete', value);
          });
        })();
        migrations.set(account, pending);
        pending.catch(() => { if (migrations.get(account) === pending) migrations.delete(account); });
      }
      await migrations.get(account);
      assertScope(value);
    }
    async function withLock(kind, input, work) {
      const value = capture(input.projectId, input.accountScopeId);
      await migrate(value); // Before acquiring either lock: no migration/lock cycle.
      return acquire(kind, value, work);
    }
    async function withWrite(value, work) {
      await migrate(value);
      const held = heldLocks.get(lockKey('state', value));
      if (held) {
        if (held.lost) throw failure('storage_lock_lost', 'The shared history lock was lost.');
        return work();
      }
      return acquire('state', value, work);
    }
    function tag(record, value, adopt) {
      if (!record) return record;
      const base = clean(record);
      if (adopt) baselines.set(cacheKey(value, record.id), base);
      Object.defineProperty(record, BASE, { value: base, enumerable: true });
      return record;
    }
    async function list(projectId = '', adopt = true) {
      const value = capture(projectId);
      await migrate(value);
      const result = []; let after = '';
      do {
        const page = await request('list', value, { after });
        for (const record of page.records) {
          result.push(tag(record, value, adopt && !heldLocks.has(lockKey('state', value))));
        }
        after = page.next;
      } while (after);
      return result;
    }
    function adopt(records) {
      const value = capture();
      for (const record of records) {
        if (record.accountScopeId === value.accountScopeId)
          baselines.set(cacheKey(value, record.id), clean(record));
      }
    }
    function hasLocalChanges(session) {
      const base = baselines.get(cacheKey(capture(), session.id));
      return Boolean(base && (session.updatedAt !== base.updatedAt || session.task !== base.task));
    }
    function wasStored(id) { return baselines.has(cacheKey(capture(), id)); }
    async function put(records, options = {}) {
      if (!records.length) return [];
      const value = capture(records[0].projectId, records[0].accountScopeId);
      if (records.some(record => record.projectId !== value.projectId || record.accountScopeId !== value.accountScopeId))
        throw failure('shared_store_scope_mismatch', 'A session batch must belong to one account and project.');
      return withWrite(value, async () => {
        const entries = records.map(record => ({
          record: clean(record),
          base: record[BASE] || baselines.get(cacheKey(value, record.id)) || null
        }));
        const written = await request('put', value, { entries, reviewRunIds: options.reviewRunIds || [] });
        // Keep the caller's submitted view as its merge baseline. A merged
        // remote change has not necessarily been applied to the visible UI.
        for (const entry of entries) baselines.set(cacheKey(value, entry.record.id), clean(entry.record));
        return written;
      });
    }
    async function get(id) {
      const value = capture();
      await migrate(value);
      const record = await request('get', value, { id });
      return tag(record, value, !heldLocks.has(lockKey('state', value)));
    }
    async function erase(method, projectId = '', id) {
      const value = capture(projectId);
      return withWrite(value, () => request(method, value, { id }));
    }
    function decorate(api) {
      legacy = api;
      wrapped = { ...api };
      const route = (name, shared) => {
        wrapped[name] = function (...args) {
          return enabled() ? shared(...args) : api[name](...args);
        };
      };
      route('buildSessionRecord', (input, options) => {
        const record = api.buildSessionRecord(input, options);
        const base = input[BASE] || baselines.get(cacheKey({ accountScopeId: record.accountScopeId }, record.id));
        if (base) Object.defineProperty(record, BASE, { value: clone(base), enumerable: true });
        return record;
      });
      route('getAllSessions', () => list());
      route('getRecord', (store, id) => store === 'sessions' ? get(id) : api.getRecord(store, id));
      route('getAllByIndex', async (store, index, value) => {
        if (store !== 'sessions') return api.getAllByIndex(store, index, value);
        const records = await list(index === 'projectId' ? value : '');
        return records.filter(record => record[index] === value);
      });
      route('claimSessionsForAccount', async (projectId, accountScopeId, deleted = []) => {
        capture(projectId, accountScopeId);
        return (await list(projectId)).filter(record => !deleted.includes(record.id));
      });
      route('putRecord', async (store, record) =>
        store === 'sessions' ? (await put([record]))[0] : api.putRecord(store, record));
      route('putRecords', (store, records, options) =>
        store === 'sessions' ? put(records, options) : api.putRecords(store, records));
      route('deleteRecord', (store, id) =>
        store === 'sessions' ? erase('delete', '', id) : api.deleteRecord(store, id));
      route('deleteByIndex', async (store, index, value) => {
        if (store !== 'sessions') return api.deleteByIndex(store, index, value);
        if (index === 'projectId') return erase('clear-project', value);
        for (const record of (await list()).filter(record => record[index] === value))
          await erase('delete', record.projectId, record.id);
      });
      route('clearStore', store =>
        store === 'sessions' ? erase('clear-account') : api.clearStore(store));
      route('clearAllStores', async () => {
        const value = capture();
        await erase('clear-account');
        // Preserve other accounts' legacy backups. Auxiliary stores remain
        // site-local and retain their existing explicit clear-all semantics.
        for (const record of await api.getAllSessions()) {
          if (record.accountScopeId === value.accountScopeId) await api.deleteRecord('sessions', record.id);
        }
        for (const store of Object.keys(api.STORES)) if (store !== 'sessions') await api.clearStore(store);
        baselines.clear();
      });
      route('listRecentProjectsAcrossAccount', async options => {
        if (!options?.accountScopeId) return [];
        capture('', options.accountScopeId);
        return api.filterRecentProjectsAcrossAccount(await list(), options);
      });
      Object.assign(wrapped, {
        sharedSessionsEnabled: enabled,
        withSharedLock: withLock,
        readSharedProjectSnapshot: projectId => list(projectId, false),
        adoptSharedSessionBaseline: adopt,
        hasUnpersistedSharedSession: hasLocalChanges,
        wasSharedSessionStored: wasStored
      });
      return wrapped;
    }
    function subscribe(listener) {
      if (!enabled() || !chromeApi.storage?.onChanged) return () => {};
      const onChange = (changes, area) => {
        const change = changes[CHANGE_KEY]?.newValue;
        if (area !== 'local' || !change || change.clientId === clientId) return;
        const account = environment.codexOverleafDeriveAccountScopeId?.();
        if (account && change.accountScopeId === account) listener(change);
      };
      chromeApi.storage.onChanged.addListener(onChange);
      return () => chromeApi.storage.onChanged.removeListener(onChange);
    }
    return { enabled, decorate, withLock, subscribe,
      async readMeta(input) {
        const value = capture(input.projectId, input.accountScopeId);
        await migrate(value);
        return request('meta-read', value);
      },
      async writeMeta(input, meta) {
        const value = capture(input.projectId, input.accountScopeId);
        return request('meta-write', value, { meta });
      }
    };
  }
  return { createBridge, ...createBridge() };
});
