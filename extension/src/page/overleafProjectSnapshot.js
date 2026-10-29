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

    function editorCaptureKey() {
      const capture = deps.captureEditorDocument?.({ path: deps.getActiveFilePath?.(), projectId: deps.getProjectId?.() });
      return capture?.ok ? capture : null;
    }

    function sameEditorCapture(left, right) {
      return Boolean(left?.ok && right?.ok) && left.view === right.view && left.state === right.state && left.doc === right.doc
        && left.text === right.text && ['path', 'projectId', 'documentId', 'targetDocumentId']
          .every(key => left.documentIdentity[key] === right.documentIdentity[key]);
    }

    function hasEditorOverlay(snapshot) {
      // Navigation reads carry the open method as their source. Only ZIP and
      // document fetches are independent of the mounted editor.
      return snapshot?.files?.some(file => typeof file.content === 'string'
        && !/^overleaf-(?:zip|doc-fetch)/.test(file.source || ''));
    }

    function hasNavigationReads(snapshot) {
      return snapshot?.files?.some(file => typeof file.content === 'string' && file.source !== 'active-editor'
        && !/^overleaf-(?:zip|doc-fetch)/.test(file.source || ''));
    }

    async function getProjectSnapshot(params = {}) {
      const cacheKey = getSnapshotCacheKey(params);
      const maxAgeMs = normalizeSnapshotMaxAge(params.maxAgeMs);
      const now = Date.now();
      const cacheEntry = snapshotCache.entries.get(cacheKey);
      const captureKey = editorCaptureKey();
      const projectId = deps.getProjectId?.();

      function currentSnapshot(snapshot) {
        if (deps.getProjectId?.() !== projectId) return withoutEditorFiles(snapshot, true);
        if (!hasEditorOverlay(snapshot) || params.allowEditorNavigation === true || hasNavigationReads(snapshot)) return snapshot;
        const captures = deps.getSnapshotEditorCaptures?.(snapshot) || [];
        if (captures.length === 1 && deps.isCaptureCurrent?.(captures[0])) return snapshot;
        // Fallback captures can be returned once, but never reused from cache.
        if (!snapshot.files.some(file => file.documentIdentity !== undefined)) return snapshot;
        return withoutEditorFiles(snapshot);
      }

      if (!params.force && cacheEntry?.pending && (params.allowEditorNavigation === false || params.zipOnly || params.serverOnly)
        && (params.serverOnly === true || sameEditorCapture(cacheEntry.pendingCaptureKey, captureKey))) {
        const snapshot = await cacheEntry.pending;
        return currentSnapshot(snapshot);
      }

      if (!params.force && cacheEntry?.value && now - cacheEntry.capturedAt <= maxAgeMs
        && (!hasEditorOverlay(cacheEntry.value) || (params.allowEditorNavigation !== true
          && sameEditorCapture(cacheEntry.captureKey, captureKey)))) {
        return withSnapshotCacheMetadata(cacheEntry.value, 'memory', cacheEntry.capturedAt);
      }

      const pending = deps.buildProjectSnapshot(params)
        .then(snapshot => {
          const captures = deps.getSnapshotEditorCaptures?.(snapshot) || [];
          const finalCapture = captures.length === 1 ? captures[0] : null;
          snapshot = currentSnapshot(snapshot);
          const capturedAt = Date.now();
          const currentEntry = snapshotCache.entries.get(cacheKey);
          if (currentEntry?.pending === pending) {
            snapshotCache.entries.set(cacheKey, {
              value: snapshot,
              captureKey: params.allowEditorNavigation === true || hasNavigationReads(snapshot) ? null : finalCapture,
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
        captureKey: cacheEntry?.captureKey,
        pendingCaptureKey: captureKey,
        capturedAt: cacheEntry?.capturedAt || 0,
        pending
      });
      return pending;
    }

    function withoutEditorFiles(snapshot, projectChanged = false) {
      const files = projectChanged ? [] : (snapshot?.files || []).filter(file => /^overleaf-(?:zip|doc-fetch)/.test(file.source || ''));
      const removed = (snapshot?.files || []).filter(file => !files.includes(file));
      return { ...snapshot, files, capabilities: { ...snapshot?.capabilities, fullProjectSnapshot: false,
        requestedPathsComplete: false, skipped: [...(snapshot?.capabilities?.skipped || []),
          ...removed.map(file => ({ path: file.path, reason: 'document_identity_mismatch' }))] } };
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
