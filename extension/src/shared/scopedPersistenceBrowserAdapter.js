(function (root, factory) {
  var QueuePolicy = root && root.CodexOverleafScopedPersistenceQueuePolicy;
  if (!QueuePolicy && typeof module === 'object' && module.exports) {
    QueuePolicy = require('./scopedPersistenceQueuePolicy');
  }
  var api = factory(QueuePolicy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafScopedPersistenceBrowserAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (QueuePolicy) {
  'use strict';

  var META_PREFIX = 'codex-overleaf-scoped-persistence-v1:';
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
        var key = scopeKey(scope);
        if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
          return normalizeMeta(fallbackMeta.get(key));
        }
        var stored = await chromeApi.storage.local.get(key);
        return normalizeMeta(stored && stored[key]);
      },
      async write(scope, meta) {
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

  return Object.freeze({
    createBrowserAdapter: createBrowserAdapter,
    normalizeScope: normalizeScope,
    scopeKey: scopeKey
  });
});
