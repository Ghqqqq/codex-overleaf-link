(function initStorageRunActions(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./selectionContext'), require('./writebackIntent'), require('./writingStyle'), require('./directoryCleanupProof'));
  } else {
    root.CodexOverleafModuleRegistry.define('StorageRunActions', ['SelectionContext', 'WritebackIntent', 'WritingStyle', 'DirectoryCleanupProof'], factory);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function storageRunActionsFactory(SelectionContext, WritebackIntent, WritingStyle, DirectoryCleanupProof) {
  'use strict';

  // Share a bounded budget across the retained history, rather than expiring
  // otherwise valid recovery data after two edits. The session builder also
  // reserves room for display metadata within the shared transport limit.
  var MAX_PERSISTED_ACTION_BYTES_PER_SESSION = 16 * 1024 * 1024;

  function compactRunsForStorage(runs, options, maxRuns, compactRun) {
    if (typeof compactRun !== 'function') {
      throw new TypeError('compactRun must be a function.');
    }
    var selectedRuns = (Array.isArray(runs) ? runs : [])
      .filter(function (run) { return run && typeof run.id === 'string'; })
      .slice(-Math.max(0, Number(maxRuns) || 0));
    var payloads = new Map();
    var remaining = Math.min(MAX_PERSISTED_ACTION_BYTES_PER_SESSION,
      Number.isFinite(options?.maxActionPayloadBytes) ? Math.max(0, options.maxActionPayloadBytes) : Infinity);
    var usedBytes = 0, usedChars = 0;
    var fits = (bytes, chars) => bytes <= remaining && (typeof options?.canRetainActionPayload !== 'function'
      || options.canRetainActionPayload(usedBytes + bytes, usedChars + chars));
    if (options && options.preserveRunActionPayload === true) {
      for (var index = selectedRuns.length - 1; index >= 0; index -= 1) {
        var run = selectedRuns[index];
        if (!hasReloadableRunActionPayload(withoutDirectoryFacts(run))) continue;
        var payload = compactRunActionPayload(run, true, { includeCaptures: false, includeDirectoryCleanup: false });
        if (payload.recoveryRetention?.state === 'omitted') { payloads.set(run.id, payload); continue; }
        var serialized = JSON.stringify(payload);
        var bytes = getUtf8ByteLength(serialized);
        if (!fits(bytes, serialized.length)) {
          payloads.set(run.id, { ...emptyActionPayload(), recoveryRetention: omitted('session-budget', bytes) });
          continue;
        }
        remaining -= bytes;
        usedBytes += bytes; usedChars += serialized.length;
        payloads.set(run.id, payload);
      }
      // Captures are optional. They must not crowd out any retained core data.
      for (var run of selectedRuns.slice().reverse()) {
        var payload = payloads.get(run.id);
        if (!payload || payload.recoveryRetention?.state === 'omitted'
          || run.undoStatus === 'applied' || ['accepted', 'rejected'].includes(run.trackedChangeStatus)) continue;
        var captures = cloneSerializableArray(run.trackedChangeCaptures);
        var extraText = captures.length ? JSON.stringify({ trackedChangeCaptures: captures }) : '';
        var extraBytes = getUtf8ByteLength(extraText);
        if (extraBytes && fits(extraBytes, extraText.length)) {
          payload.trackedChangeCaptures = captures;
          remaining -= extraBytes;
          usedBytes += extraBytes; usedChars += extraText.length;
        }
      }
    }
    // Passive directory history uses only the space left after all original
    // recovery payloads and optional captures have been selected.
    var directoryRemaining = Number.isFinite(options?.maxOptionalDirectoryBytes)
      ? Math.max(0, options.maxOptionalDirectoryBytes) : Infinity;
    return selectedRuns.map(function (run) {
      var payload = payloads.get(run.id) || compactRunActionPayload(run, false, { includeDirectoryCleanup: false });
      if (options?.deferDirectoryCleanup !== true) payload = appendDirectoryFacts(payload, run,
        options?.preserveRunActionPayload === true, function (bytes, chars) {
          if (bytes > directoryRemaining || !fits(bytes, chars)) return false;
          directoryRemaining -= bytes; remaining -= bytes;
          usedBytes += bytes; usedChars += chars;
          return true;
        }, 'session-budget');
      return compactRun(run, payloads.has(run.id) && !coreWasOmitted(payload), payload);
    });
  }

  // Keep the complete display history while allocating finite recovery space
  // across the current project. A record plus its previous merge baseline is
  // transported together; a readable batch must also fit the response bound.
  function compactSessionBatchActions(records, options = {}, buildSessionRecord, SharedSessionTransfer) {
    var budget = SharedSessionTransfer.MAX_RESPONSE_BYTES - 64 * 1024;
    if (SharedSessionTransfer.byteLength(JSON.stringify(records)) <= budget) return records;
    var summaries = records.map(record => buildSessionRecord(record, { preserveRunActionPayload: false, deferDirectoryCleanup: true }));
    var remaining = Math.max(0, budget - SharedSessionTransfer.byteLength(JSON.stringify(summaries)));
    var allocated = new Map();
    var ordered = records.slice().sort((a, b) => Number(b.id === options.activeSessionId) - Number(a.id === options.activeSessionId)
      || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    for (var record of ordered) {
      var summary = summaries.find(item => item.id === record.id);
      var next = buildSessionRecord(record, { preserveRunActionPayload: true, maxActionPayloadBytes: remaining, deferDirectoryCleanup: true });
      remaining -= Math.max(0, SharedSessionTransfer.byteLength(JSON.stringify(next)) - SharedSessionTransfer.byteLength(JSON.stringify(summary)));
      allocated.set(record.id, next);
    }
    // Do not let an active session's optional directory facts evict another
    // session's existing Undo core under the shared response bound.
    for (var record of ordered) {
      var core = allocated.get(record.id);
      var sourceRuns = new Map((record.runs || []).map(run => [run.id, run]));
      var withFacts = { ...core, runs: core.runs.map(run => {
        var source = sourceRuns.get(run.id), next = { ...run };
        if (source?.pendingDirectoryCleanup) next.pendingDirectoryCleanup = source.pendingDirectoryCleanup;
        if (source?.recoveryRetention?.directoryCleanup === true) next.recoveryRetention = {
          ...(next.recoveryRetention || { ...source.recoveryRetention, coreRetained: true }), directoryCleanup: true };
        return next;
      }) };
      var enriched = buildSessionRecord(withFacts, { preserveRunActionPayload: true, maxOptionalDirectoryBytes: remaining });
      remaining -= Math.max(0, SharedSessionTransfer.byteLength(JSON.stringify(enriched)) - SharedSessionTransfer.byteLength(JSON.stringify(core)));
      allocated.set(record.id, enriched);
    }
    return records.map(record => allocated.get(record.id));
  }

  function hasReloadableRunActionPayload(run) {
    if (!run || run.forkSnapshot === true) return false;
    if (runDirectoryCleanup(run)) return true;
    if (run.undoStatus === 'applied' || ['accepted', 'rejected'].includes(run.trackedChangeStatus)) return false;
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

  function runDirectoryCleanup(run) {
    var proof = DirectoryCleanupProof.normalize(run?.pendingDirectoryCleanup);
    return proof && proof.runId === run.id && proof.projectId === run.runProjectId ? proof : null;
  }

  function omitted(reason, bytes = 0) {
    return { state: 'omitted', reason, bytes };
  }

  function withoutDirectoryFacts(run) {
    var core = { ...run };
    delete core.pendingDirectoryCleanup;
    if (core.recoveryRetention?.directoryCleanup === true) {
      if (core.recoveryRetention.coreRetained === true) delete core.recoveryRetention;
      else {
        core.recoveryRetention = { ...core.recoveryRetention };
        delete core.recoveryRetention.directoryCleanup;
        delete core.recoveryRetention.coreRetained;
      }
    }
    return core;
  }

  function coreWasOmitted(payload) {
    return payload.recoveryRetention?.state === 'omitted' && payload.recoveryRetention.coreRetained !== true;
  }

  function appendDirectoryFacts(payload, run, keep, fits, reason) {
    if (run?.forkSnapshot === true) return payload;
    var directory = runDirectoryCleanup(run), previous = run?.recoveryRetention;
    if (!directory && previous?.directoryCleanup !== true) return payload;
    if (directory && keep) {
      var extended = { ...payload, pendingDirectoryCleanup: directory };
      var before = JSON.stringify(payload), after = JSON.stringify(extended);
      if (fits(getUtf8ByteLength(after) - getUtf8ByteLength(before), after.length - before.length)) return extended;
    }
    // The existing omission marker distinguishes optional history from lost
    // recovery authority. Never imply that a retained Undo core was discarded.
    var retention = coreWasOmitted(payload) ? payload.recoveryRetention
      : omitted(!keep ? 'fallback' : directory ? reason : previous.reason,
        directory ? getUtf8ByteLength(JSON.stringify(directory)) : previous.bytes);
    return { ...payload, recoveryRetention: { ...retention, directoryCleanup: true,
      ...(!coreWasOmitted(payload) ? { coreRetained: true } : {}) } };
  }

  function compactRunActionPayload(run, keepActionPayload, options = {}) {
    var payload = compactCoreActionPayload(withoutDirectoryFacts(run), keepActionPayload, options);
    if (options.includeDirectoryCleanup === false) return payload;
    var serialized = JSON.stringify(payload);
    return appendDirectoryFacts(payload, run, keepActionPayload,
      bytes => getUtf8ByteLength(serialized) + bytes <= MAX_PERSISTED_ACTION_BYTES_PER_SESSION, 'run-budget');
  }

  function compactCoreActionPayload(run, keepActionPayload, options = {}) {
    var empty = emptyActionPayload();
    if (!keepActionPayload || !hasReloadableRunActionPayload(run)) {
      if (hasReloadableRunActionPayload(run)) empty.recoveryRetention = omitted('fallback');
      else if (run?.recoveryRetention?.state === 'omitted' && !run.forkSnapshot
        && run.undoStatus !== 'applied' && !['accepted', 'rejected'].includes(run.trackedChangeStatus)) {
        empty.recoveryRetention = omitted(
          ['run-budget', 'session-budget', 'fallback', 'invalid'].includes(run.recoveryRetention.reason)
            ? run.recoveryRetention.reason : 'invalid', Math.max(0, Number(run.recoveryRetention.bytes) || 0));
      }
      return empty;
    }
    var terminal = run.undoStatus === 'applied' || ['accepted', 'rejected'].includes(run.trackedChangeStatus);
    var payload = terminal ? emptyActionPayload() : {
      appliedOperations: cloneSerializableArray(run.appliedOperations),
      undoOperations: cloneSerializableArray(run.undoOperations),
      undoBaseFiles: cloneSerializableArray(run.undoBaseFiles),
      undoTrackedChanges: cloneSerializableArray(run.undoTrackedChanges),
      undoExpectedFiles: cloneSerializableArray(run.undoExpectedFiles)
    };
    if (!terminal && Object.keys(payload).some(key => run[key]?.length && !payload[key].length)) {
      return { ...empty, recoveryRetention: omitted('invalid') };
    }
    var serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_error) {
      return { ...empty, recoveryRetention: omitted('invalid') };
    }
    var bytes = getUtf8ByteLength(serialized);
    if (bytes > MAX_PERSISTED_ACTION_BYTES_PER_SESSION) return { ...empty,
      recoveryRetention: omitted('run-budget', bytes) };
    if (options.includeCaptures === false || terminal) return payload;
    const captures = cloneSerializableArray(run.trackedChangeCaptures);
    if (captures.length) {
      const extended = { ...payload, trackedChangeCaptures: captures };
      if (getUtf8ByteLength(JSON.stringify(extended)) <= MAX_PERSISTED_ACTION_BYTES_PER_SESSION) return extended;
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
    var terminal = run => ['accepted', 'rejected'].includes(run?.trackedChangeStatus) || run?.undoStatus === 'applied';
    var incomingRuns = new Map((incoming.runs || []).map(run => [run.id, run]));
    var existingRuns = new Map((existing.runs || []).map(run => [run.id, run]));
    var requestedIds = new Set(reviewRunIds || []);
    var explicitReview = Array.from(requestedIds).some(id => {
      var run = incomingRuns.get(id);
      return ['accepted', 'rejected', 'needs_review'].includes(run?.trackedChangeStatus)
        || ['applied', 'partial'].includes(run?.undoStatus);
    });
    var newer = (Date.parse(incoming.updatedAt) || 0) >= (Date.parse(existing.updatedAt) || 0);
    if (!newer && !explicitReview) return incoming;
    var base = newer ? incoming : existing;
    var fields = ['trackedChangeStatus', 'undoStatus', 'undoOwnerProtocol', 'undoTrackedChanges', 'undoExpectedFiles',
      'undoOperations', 'undoBaseFiles', 'appliedOperations', 'trackedChangeCaptures', 'recoveryRetention', 'settlement', 'settlementFacts'];
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

  // A successful durable write can omit an oversized checkpoint while the
  // current tab still has it. Warn only the view and exact action revision
  // that was saved; never mutate or remove its in-memory recovery material.
  function projectRetentionUpdates({ liveState, capturedState, written, capturedScope, currentScope } = {}) {
    if (!capturedScope?.accountScopeId || !capturedScope.projectId
      || !Number.isSafeInteger(capturedScope.generation)
      || ['accountScopeId', 'projectId', 'generation'].some(key => capturedScope[key] !== currentScope?.[key])) return [];
    var fields = ['appliedOperations', 'undoOperations', 'undoBaseFiles', 'undoTrackedChanges',
      'undoExpectedFiles', 'undoStatus', 'trackedChangeStatus', 'pendingDirectoryCleanup'];
    var fingerprint = run => JSON.stringify(fields.map(field => run[field]));
    var updates = [];
    for (var record of written || []) {
      if (record.accountScopeId !== capturedScope.accountScopeId || record.projectId !== capturedScope.projectId) continue;
      var live = liveState?.sessions?.find(session => session.id === record.id);
      var captured = capturedState?.sessions?.find(session => session.id === record.id);
      for (var storedRun of record.runs || []) {
        var run = live?.runs?.find(run => run.id === storedRun.id);
        var original = captured?.runs?.find(run => run.id === storedRun.id);
        if (!run || !original || run.runProjectId !== capturedScope.projectId
          || original.runProjectId !== capturedScope.projectId || !hasReloadableRunActionPayload(run)) continue;
        try {
          if (fingerprint(run) !== fingerprint(original)) continue;
          if (storedRun.recoveryRetention?.state === 'omitted') updates.push({ runId: run.id, retention: { ...storedRun.recoveryRetention } });
          else if (fingerprint(storedRun) === fingerprint(original)) updates.push({ runId: run.id, retention: null });
        } catch (_error) { /* Invalid data cannot establish a revision. */ }
      }
    }
    return updates;
  }

  function projectRetentionWarnings(input) {
    return projectRetentionUpdates(input).filter(update => update.retention).map(update => update.runId);
  }

  return {
    projectRetentionUpdates: projectRetentionUpdates,
    projectRetentionWarnings: projectRetentionWarnings,
    compactSessionBatchActions: compactSessionBatchActions,
    compactStructuredEventValue: compactStructuredEventValue,
    mergeSessionReviewState: mergeSessionReviewState,
    compactRunsForStorage: compactRunsForStorage,
    compactRunActionPayload: compactRunActionPayload,
    compactProviderSnapshot: compactProviderSnapshot,
    compactRunExecutionSnapshot: compactRunExecutionSnapshot,
    hashString: hashString
  };
});
