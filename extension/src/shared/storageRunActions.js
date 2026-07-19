(function initStorageRunActions(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafStorageRunActions = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageRunActionsFactory() {
  'use strict';

  var MAX_PERSISTED_ACTION_RUNS_PER_SESSION = 2;
  var MAX_PERSISTED_ACTION_BYTES_PER_RUN = 320 * 1024;

  function compactRunsForStorage(runs, options, maxRuns, compactRun) {
    if (typeof compactRun !== 'function') {
      throw new TypeError('compactRun must be a function.');
    }
    var selectedRuns = (Array.isArray(runs) ? runs : [])
      .filter(function (run) { return run && typeof run.id === 'string'; })
      .slice(-Math.max(0, Number(maxRuns) || 0));
    var actionRunIds = new Set();
    if (options && options.preserveRunActionPayload === true) {
      for (var index = selectedRuns.length - 1;
        index >= 0 && actionRunIds.size < MAX_PERSISTED_ACTION_RUNS_PER_SESSION;
        index -= 1) {
        if (hasReloadableRunActionPayload(selectedRuns[index])) {
          actionRunIds.add(selectedRuns[index].id);
        }
      }
    }
    return selectedRuns.map(function (run) {
      return compactRun(run, actionRunIds.has(run.id));
    });
  }

  function hasReloadableRunActionPayload(run) {
    var trackedStatus = run && run.trackedChangeStatus;
    var trackedLifecycle = (trackedStatus === 'pending' || trackedStatus === 'needs_review')
      && Array.isArray(run.undoTrackedChanges) && run.undoTrackedChanges.length > 0
      && Array.isArray(run.undoExpectedFiles) && run.undoExpectedFiles.length > 0
      && Array.isArray(run.appliedOperations) && run.appliedOperations.length > 0;
    var legacyUndo = Array.isArray(run && run.undoOperations) && run.undoOperations.length > 0;
    return trackedLifecycle || legacyUndo;
  }

  function compactRunActionPayload(run, keepActionPayload) {
    var empty = emptyActionPayload();
    if (!keepActionPayload || !hasReloadableRunActionPayload(run)) {
      return empty;
    }
    var payload = {
      appliedOperations: cloneSerializableArray(run.appliedOperations),
      undoOperations: cloneSerializableArray(run.undoOperations),
      undoBaseFiles: cloneSerializableArray(run.undoBaseFiles),
      undoTrackedChanges: cloneSerializableArray(run.undoTrackedChanges),
      undoExpectedFiles: cloneSerializableArray(run.undoExpectedFiles)
    };
    var serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_error) {
      return empty;
    }
    return getUtf8ByteLength(serialized) <= MAX_PERSISTED_ACTION_BYTES_PER_RUN ? payload : empty;
  }

  function emptyActionPayload() {
    return {
      appliedOperations: [],
      undoOperations: [],
      undoBaseFiles: [],
      undoTrackedChanges: [],
      undoExpectedFiles: []
    };
  }

  function cloneSerializableArray(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    try {
      var clone = JSON.parse(JSON.stringify(value));
      return Array.isArray(clone) ? clone : [];
    } catch (_error) {
      return [];
    }
  }

  function getUtf8ByteLength(value) {
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(value).byteLength;
    }
    return value.length * 2;
  }

  function compactProviderSnapshot(value) {
    return {
      providerId: typeof value.providerId === 'string' && value.providerId ? value.providerId : 'builtin',
      providerName: typeof value.providerName === 'string' ? value.providerName : '',
      providerRevision: Number.isFinite(Number(value.providerRevision)) ? Number(value.providerRevision) : 0,
      providerEndpointHost: typeof value.providerEndpointHost === 'string' ? value.providerEndpointHost : ''
    };
  }

  return {
    compactRunsForStorage: compactRunsForStorage,
    compactRunActionPayload: compactRunActionPayload,
    compactProviderSnapshot: compactProviderSnapshot
  };
});
