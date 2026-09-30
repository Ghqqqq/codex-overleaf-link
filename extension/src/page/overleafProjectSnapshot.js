(function initOverleafProjectSnapshot(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafProjectSnapshot = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function overleafProjectSnapshotFactory() {
  'use strict';

  const SNAPSHOT_DEFAULT_MAX_AGE_MS = 2500;
  const SNAPSHOT_MAX_CACHE_MS = 15000;
  const FILE_LIST_DEFAULT_MAX_AGE_MS = 300000;

  function create(deps = {}) {
    const pageWindow = deps.window || window;
    const snapshotCache = createKeyedCache();
    const fileListCache = createKeyedCache();

    async function getProjectSnapshot(params = {}) {
      const cacheKey = getSnapshotCacheKey(params);
      const maxAgeMs = normalizeSnapshotMaxAge(params.maxAgeMs);
      const now = Date.now();
      const cacheEntry = snapshotCache.entries.get(cacheKey);

      if (!params.force && cacheEntry?.pending) {
        return cacheEntry.pending;
      }

      if (!params.force && cacheEntry?.value && now - cacheEntry.capturedAt <= maxAgeMs) {
        return withSnapshotCacheMetadata(cacheEntry.value, 'memory', cacheEntry.capturedAt);
      }

      const pending = deps.buildProjectSnapshot(params)
        .then(snapshot => {
          const capturedAt = Date.now();
          const currentEntry = snapshotCache.entries.get(cacheKey);
          if (currentEntry?.pending === pending) {
            snapshotCache.entries.set(cacheKey, {
              value: snapshot,
              capturedAt,
              pending: null
            });
          }
          return withSnapshotCacheMetadata(snapshot, 'fresh', capturedAt);
        })
        .finally(() => {
          const currentEntry = snapshotCache.entries.get(cacheKey);
          if (currentEntry?.pending === pending) {
            currentEntry.pending = null;
          }
        });

      snapshotCache.entries.set(cacheKey, {
        value: cacheEntry?.value || null,
        capturedAt: cacheEntry?.capturedAt || 0,
        pending
      });
      return pending;
    }

    async function getProjectFileList(params = {}) {
      const cacheKey = getProjectFileListCacheKey(params);
      const maxAgeMs = normalizeFileListMaxAge(params.maxAgeMs);
      const now = Date.now();
      const cacheEntry = fileListCache.entries.get(cacheKey);

      if (cacheEntry?.pending) {
        return cacheEntry.pending;
      }

      if (!params.force && cacheEntry?.value && now - cacheEntry.capturedAt <= maxAgeMs) {
        return withFileListCacheMetadata(cacheEntry.value, 'memory', cacheEntry.capturedAt);
      }

      const pending = deps.buildProjectFileList(params)
        .then(fileList => {
          const capturedAt = Date.now();
          const currentEntry = fileListCache.entries.get(cacheKey);
          if (currentEntry?.pending === pending) {
            if (shouldCacheProjectFileList(fileList, params)) {
              fileListCache.entries.set(cacheKey, {
                value: fileList,
                capturedAt,
                pending: null
              });
            } else {
              fileListCache.entries.delete(cacheKey);
            }
          }
          return withFileListCacheMetadata(fileList, 'fresh', capturedAt);
        })
        .finally(() => {
          const currentEntry = fileListCache.entries.get(cacheKey);
          if (currentEntry?.pending === pending) {
            currentEntry.pending = null;
          }
        });

      fileListCache.entries.set(cacheKey, {
        value: cacheEntry?.value || null,
        capturedAt: cacheEntry?.capturedAt || 0,
        pending
      });
      return pending;
    }

    function invalidateProjectSnapshot(options = {}) {
      resetKeyedCache(snapshotCache);
      if (options.invalidateFileList === true) {
        resetKeyedCache(fileListCache);
      }
    }

    function getSnapshotCacheKey(params = {}) {
      const focusKey = Array.isArray(params.focusFiles)
        ? params.focusFiles.map(path => deps.normalizePath?.(path)).filter(Boolean).sort().join(',')
        : '';
      return [
        pageWindow.location.origin,
        deps.getProjectId?.() || pageWindow.location.pathname || pageWindow.location.href,
        params.preferLightweight ? 'lightweight' : 'full',
        params.zipOnly ? 'zip-only' : 'zip-or-page',
        params.serverOnly === true ? 'server-only' : 'editor-overlay',
        params.allowZipFallback === false ? 'no-zip-fallback' : 'zip-fallback',
        params.allowEditorNavigation === false ? 'no-editor-navigation' : params.allowEditorNavigation === true ? 'editor-navigation' : 'default-editor-navigation',
        params.requireFullProject ? 'require-full-project' : 'allow-partial-project',
        params.restrictToRequestedPathsOnly === true ? 'requested-only' : 'allow-project-expansion',
        params.includeBinaryFiles ? 'binary' : 'text',
        params.includeContent === false ? 'list' : 'content',
        `zip-timeout=${normalizeZipTimeoutKey(params.zipTimeoutMs)}`,
        params.requestedPathsCacheKey || '',
        focusKey
      ].join(':');
    }

  function getProjectFileListCacheKey(params = {}) {
      return [
        pageWindow.location.origin,
        deps.getProjectId?.() || pageWindow.location.pathname || pageWindow.location.href,
        params.preferExact === false ? 'tree' : 'exact',
        params.exactOnly === true || params.requireExact === true ? 'required' : 'fallback'
      ].join(':');
    }

    return {
      getProjectFileList,
      getProjectSnapshot,
      invalidateProjectSnapshot
    };
  }

  function shouldCacheProjectFileList(fileList, params = {}) {
    if (params.preferExact === false) {
      return true;
    }
    return fileList?.capabilities?.method === 'overleaf-zip-file-list';
  }

  function createKeyedCache() {
    return {
      entries: new Map()
    };
  }

  function resetKeyedCache(cache) {
    cache.entries.clear();
  }

  function normalizeSnapshotMaxAge(value) {
    if (value === 0) {
      return 0;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return SNAPSHOT_DEFAULT_MAX_AGE_MS;
    }
    return Math.max(0, Math.min(number, SNAPSHOT_MAX_CACHE_MS));
  }

  function normalizeFileListMaxAge(value) {
    if (value === 0) {
      return 0;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return FILE_LIST_DEFAULT_MAX_AGE_MS;
    }
    return Math.max(0, Math.min(number, FILE_LIST_DEFAULT_MAX_AGE_MS));
  }

  function normalizeZipTimeoutKey(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : 'default';
  }

  function withSnapshotCacheMetadata(snapshot, cacheState, capturedAt) {
    const capabilities = snapshot?.capabilities || {};
    return {
      ...snapshot,
      capabilities: {
        ...capabilities,
        diagnostics: {
          ...(capabilities.diagnostics || {}),
          snapshotCache: cacheState,
          snapshotCapturedAt: new Date(capturedAt).toISOString()
        }
      }
    };
  }

  function withFileListCacheMetadata(fileList, cacheState, capturedAt) {
    const capabilities = fileList?.capabilities || {};
    return {
      ...fileList,
      capabilities: {
        ...capabilities,
        diagnostics: {
          ...(capabilities.diagnostics || {}),
          fileListCache: cacheState,
          fileListCapturedAt: new Date(capturedAt).toISOString()
        }
      }
    };
  }

  return {
    create,
    normalizeFileListMaxAge,
    normalizeSnapshotMaxAge
  };
});
