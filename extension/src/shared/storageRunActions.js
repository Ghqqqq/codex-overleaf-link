(function initStorageRunActions(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./selectionContext'), require('./writebackIntent'), require('./writingStyle'));
  } else {
    root.CodexOverleafModuleRegistry.define('StorageRunActions', ['SelectionContext', 'WritebackIntent', 'WritingStyle'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageRunActionsFactory(SelectionContext, WritebackIntent, WritingStyle) {
  'use strict';

  var MAX_PERSISTED_ACTION_RUNS_PER_SESSION = 2;
  // Undo/Accept need whole pre- and post-images of every written file, so one
  // run that edits a 120 KB roadmap and creates a 100 KB chapter already needs
  // ~560 KB. The old 320 KB cap silently dropped the whole payload and the
  // buttons vanished after a reload. Two runs per session keep this bounded.
  var MAX_PERSISTED_ACTION_BYTES_PER_RUN = 2 * 1024 * 1024;

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
    // Overleaf can expose a working native editor-undo checkpoint before its
    // Reviewing DOM markers are discoverable. Preserve that checkpoint too so
    // a reload does not erase the only safe rollback path while the document
    // still contains an unresolved tracked change.
    var reviewingEditorUndo = trackedStatus !== 'accepted'
      && trackedStatus !== 'rejected'
      && run && run.undoStatus !== 'applied'
      && run.executionSnapshot && run.executionSnapshot.requireReviewing === true
      && Array.isArray(run.undoExpectedFiles) && run.undoExpectedFiles.length > 0
      && Array.isArray(run.appliedOperations) && run.appliedOperations.length > 0;
    var legacyUndo = Array.isArray(run && run.undoOperations) && run.undoOperations.length > 0;
    return trackedLifecycle || reviewingEditorUndo || legacyUndo;
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
    if (getUtf8ByteLength(serialized) > MAX_PERSISTED_ACTION_BYTES_PER_RUN) return empty;
    const captures = cloneSerializableArray(run.trackedChangeCaptures);
    if (captures.length) {
      const extended = { ...payload, trackedChangeCaptures: captures };
      if (getUtf8ByteLength(JSON.stringify(extended)) <= MAX_PERSISTED_ACTION_BYTES_PER_RUN) return extended;
    }
    return payload; // Optional capture evidence must never evict a mature Undo payload.
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

  // Persist only execution metadata; never infer a missing historical setting.
  function compactRunExecutionSnapshot(run, normalizeString) {
    var snapshot = run && run.executionSnapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return {};
    var normalize = typeof normalizeString === 'function' ? normalizeString : String;
    var compact = {};
    var fields = ['schemaVersion', 'mode', 'providerId', 'providerRevision', 'model',
      'reasoningEffort', 'speedTier', 'autoRecompile', 'requireReviewing', 'capturedAt', 'source'];
    for (var key of fields) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
      var value = snapshot[key];
      if (typeof value === 'string') compact[key] = normalize(value);
      else if (value === null || typeof value === 'number' || typeof value === 'boolean') compact[key] = value;
    }
    if (Array.isArray(snapshot.focusFiles)) {
      compact.focusFiles = snapshot.focusFiles.slice(0, 100)
        .filter(function (value) { return typeof value === 'string'; }).map(normalize);
    }
    compact.selectionContext = SelectionContext.normalize(snapshot.selectionContext);
    compact.writingStyle = WritingStyle.normalizeSnapshot(snapshot.writingStyle);
    return { executionSnapshot: compact };
  }

  function compactProviderSnapshot(value) {
    return {
      providerId: typeof value.providerId === 'string' && value.providerId ? value.providerId : 'builtin',
      providerName: typeof value.providerName === 'string' ? value.providerName : '',
      providerRevision: Number.isFinite(Number(value.providerRevision)) ? Number(value.providerRevision) : 0,
      providerEndpointHost: typeof value.providerEndpointHost === 'string' ? value.providerEndpointHost : ''
    };
  }

  function compactStructuredEventValue(value, options, depth) {
    var config = options || {};
    var d = depth || 0;
    if (typeof value === 'string') {
      return typeof config.normalizeString === 'function' ? config.normalizeString(value) : value;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (d > 6 || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      return value.slice(0, 32).map(function (item) {
        return compactStructuredEventValue(item, config, d + 1);
      });
    }
    var out = {};
    var keys = Object.keys(value).slice(0, 32);
    for (var i = 0; i < keys.length; i++) {
      out[keys[i]] = compactStructuredEventValue(value[keys[i]], config, d + 1);
    }
    return out;
  }

  // Review terminal states are monotonic even when a later session snapshot is stale.
  function mergeSessionReviewState(incoming, existing, reviewRunIds) {
    if (!existing || incoming.id !== existing.id || incoming.projectId !== existing.projectId
      || !incoming.accountScopeId || incoming.accountScopeId !== existing.accountScopeId) return incoming;
    var terminal = run => ['accepted', 'rejected'].includes(run?.trackedChangeStatus);
    var incomingRuns = new Map((incoming.runs || []).map(run => [run.id, run]));
    var existingRuns = new Map((existing.runs || []).map(run => [run.id, run]));
    var requestedIds = new Set(reviewRunIds || []);
    var explicitReview = Array.from(requestedIds).some(id =>
      ['accepted', 'rejected', 'needs_review'].includes(incomingRuns.get(id)?.trackedChangeStatus));
    var newer = (Date.parse(incoming.updatedAt) || 0) >= (Date.parse(existing.updatedAt) || 0);
    if (!newer && !explicitReview) return incoming;
    var base = newer ? incoming : existing;
    var fields = ['trackedChangeStatus', 'undoStatus', 'undoTrackedChanges', 'undoExpectedFiles',
      'undoOperations', 'undoBaseFiles', 'appliedOperations', 'trackedChangeCaptures', 'settlement', 'settlementFacts'];
    var changed = false;
    var runs = (base.runs || []).map(function (run) {
      var previous = existingRuns.get(run.id), candidate = incomingRuns.get(run.id);
      // Never revive a removed run or change the first durably recorded review decision.
      var source = terminal(previous) ? previous
        : explicitReview && requestedIds.has(run.id) ? candidate : null;
      if (!source || source === run) return run;
      if (source.runProjectId && source.runProjectId !== incoming.projectId) return run;
      var merged = { ...run };
      for (var field of fields) {
        if (Object.prototype.hasOwnProperty.call(source, field)) {
          merged[field] = JSON.parse(JSON.stringify(source[field]));
        } else {
          delete merged[field];
        }
      }
      changed = true;
      return merged;
    });
    if (!changed) return base;
    var merged = { ...base, runs };
    if (explicitReview && !newer) {
      merged.updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) || 0,
        Date.parse(incoming.updatedAt) || 0) + 1).toISOString();
    }
    return merged;
  }

  function hashString(value) {
    var hash = 2166136261;
    var text = String(value || '');
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  return {
    compactStructuredEventValue: compactStructuredEventValue,
    mergeSessionReviewState: mergeSessionReviewState,
    compactRunsForStorage: compactRunsForStorage,
    compactRunActionPayload: compactRunActionPayload,
    compactProviderSnapshot: compactProviderSnapshot,
    compactRunExecutionSnapshot: compactRunExecutionSnapshot,
    hashString: hashString
  };
});
