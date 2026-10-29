(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./scopedPersistenceQueuePolicy'), require('./sharedSessionBridge'));
  } else {
    root.CodexOverleafModuleRegistry.define(
      'ScopedPersistenceBrowserAdapter',
      ['ScopedPersistenceQueuePolicy', 'SharedSessionBridge'],
      factory
    );
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (QueuePolicy, SharedSessions) {
  'use strict';

  var META_PREFIX = 'codex-overleaf-scoped-persistence-v1:';
  var MIRROR_FENCE_PREFIX = 'codex-overleaf-mirror-reuse-fence-v1:';
  var fallbackMeta = new Map();
  var cleanPart = QueuePolicy.cleanPart;
  var normalizeMeta = QueuePolicy.normalizeMeta;

  function normalizeScope(input) {
    return Object.freeze({
      accountScopeId: cleanPart(input && input.accountScopeId),
      projectId: cleanPart(input && input.projectId)
    });
  }

  function scopeKey(scope) {
    var normalized = normalizeScope(scope);
    if (!normalized.accountScopeId) {
      var error = new Error('A stable account scope is required for durable persistence.');
      error.code = 'account_scope_unavailable';
      throw error;
    }
    return META_PREFIX + encodeURIComponent(normalized.accountScopeId)
      + ':' + encodeURIComponent(normalized.projectId);
  }

  function createBrowserAdapter(options) {
    options = options || {};
    var chromeApi = options.chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    var locksApi = Object.prototype.hasOwnProperty.call(options, 'locksApi')
      ? options.locksApi
      : (typeof navigator !== 'undefined' ? navigator.locks : null);
    return {
      async read(scope) {
        if (SharedSessions.enabled()) return normalizeMeta(await SharedSessions.readMeta(scope));
        var key = scopeKey(scope);
        if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
          return normalizeMeta(fallbackMeta.get(key));
        }
        var stored = await chromeApi.storage.local.get(key);
        return normalizeMeta(stored && stored[key]);
      },
      async write(scope, meta) {
        if (SharedSessions.enabled()) return SharedSessions.writeMeta(scope, normalizeMeta(meta));
        var key = scopeKey(scope);
        var normalized = normalizeMeta(meta);
        if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
          fallbackMeta.set(key, normalized);
          return normalized;
        }
        await chromeApi.storage.local.set({ [key]: normalized });
        return normalized;
      },
      withLock(scope, work) {
        if (SharedSessions.enabled()) return SharedSessions.withLock('state', scope, work);
        var key = scopeKey(scope);
        if (locksApi && typeof locksApi.request === 'function') {
          return locksApi.request(key, { mode: 'exclusive' }, work);
        }
        var error = new Error('A cross-realm browser lock is required for durable persistence.');
        error.code = 'storage_lock_unavailable';
        return Promise.reject(error);
      }
    };
  }

  async function getMirrorReuseFences(scope, chromeApi) {
    chromeApi = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    if (!normalizeScope(scope).projectId || !chromeApi?.storage?.local) throw new Error('Mirror fence storage is unavailable.');
    var prefix = MIRROR_FENCE_PREFIX + scopeKey(scope).slice(META_PREFIX.length) + ':';
    var stored = await chromeApi.storage.local.get(null);
    return Object.keys(stored || {}).filter(key => key.startsWith(prefix)).map(key => {
      var generation = key.slice(prefix.length);
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(generation) || stored[key]?.v !== 1 || stored[key].generation !== generation) {
        throw new Error('Mirror fence storage contains an unreadable generation.');
      }
      return generation;
    }).sort();
  }

  async function setMirrorReuseFence(scope, generation, chromeApi) {
    chromeApi = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    if (!normalizeScope(scope).projectId || !chromeApi?.storage?.local
      || !/^[a-zA-Z0-9_-]{1,160}$/.test(generation)) throw new Error('Mirror fence storage is unavailable.');
    var key = MIRROR_FENCE_PREFIX + scopeKey(scope).slice(META_PREFIX.length) + ':' + generation;
    await chromeApi.storage.local.set({ [key]: { v: 1, generation } });
  }

  async function clearMirrorReuseFences(scope, generations, chromeApi) {
    chromeApi = chromeApi || (typeof chrome !== 'undefined' ? chrome : null);
    if (!normalizeScope(scope).projectId || !chromeApi?.storage?.local || !Array.isArray(generations)
      || generations.some(generation => !/^[a-zA-Z0-9_-]{1,160}$/.test(generation))) throw new Error('Mirror fence storage is unavailable.');
    var prefix = MIRROR_FENCE_PREFIX + scopeKey(scope).slice(META_PREFIX.length) + ':';
    await chromeApi.storage.local.remove(generations.map(generation => prefix + generation));
  }

  return Object.freeze({
    getMirrorReuseFences: getMirrorReuseFences,
    setMirrorReuseFence: setMirrorReuseFence,
    clearMirrorReuseFences: clearMirrorReuseFences,
    createBrowserAdapter: createBrowserAdapter,
    normalizeScope: normalizeScope,
    scopeKey: scopeKey
  });
});
