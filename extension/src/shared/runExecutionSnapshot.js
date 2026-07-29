(function initCodexOverleafRunExecutionSnapshot(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./providerProfiles'), require('./runExecutionSnapshotCodec'));
  } else {
    root.CodexOverleafModuleRegistry.define('RunExecutionSnapshot', [
      'ProviderProfiles',
      'RunExecutionSnapshotCodec'
    ], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runExecutionSnapshotFactory(ProviderProfiles, Codec) {
  'use strict';

  function create(input = {}) {
    const providerId = Codec.normalizeText(input.providerId) || 'builtin';
    return Codec.normalizeSnapshot(input, {
      source: input.source || 'submitted',
      requireProviderRevision: providerId !== 'builtin'
    });
  }

  function capture(input = {}, options = {}) {
    return Codec.normalizeSnapshot(input, options);
  }

  function captureRawQueueTuple(rawQueueItem = {}, fallbackInput = {}) {
    const rawPayload = rawQueueItem?.payload && typeof rawQueueItem.payload === 'object'
      ? rawQueueItem.payload
      : rawQueueItem;
    const persisted = rawQueueItem?.executionSnapshot || rawPayload?.executionSnapshot;
    if (persisted && typeof persisted === 'object') {
      return Codec.normalizeSnapshot(persisted, { source: persisted.source || 'submitted' });
    }
    const raw = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const fallback = fallbackInput && typeof fallbackInput === 'object' ? fallbackInput : {};
    const captured = {};
    let inferred = false;
    for (const field of Codec.TUPLE_FIELDS) {
      if (Codec.hasOwn(raw, field)) captured[field] = Codec.cloneValue(raw[field]);
      else {
        captured[field] = Codec.cloneValue(fallback[field]);
        inferred = true;
      }
    }
    const providerId = Codec.normalizeText(captured.providerId) || 'builtin';
    if (providerId !== 'builtin' && !Codec.normalizeRevision(captured.providerRevision)
      && (!Codec.hasOwn(raw, 'providerRevision') || captured.providerRevision === '' || captured.providerRevision == null)) {
      captured.providerRevision = fallback.providerRevision;
      inferred = true;
    }
    return Codec.normalizeSnapshot(captured, {
      source: inferred ? 'legacy-inferred' : 'legacy-captured'
    });
  }

  function resolveForExecution(value = {}, options = {}) {
    const persisted = value.executionSnapshot || value;
    const snapshot = Codec.normalizeSnapshot(persisted, { source: persisted.source || 'submitted' });
    if (snapshot.providerId === 'builtin') return Codec.normalizeSnapshot(snapshot, { source: snapshot.source });
    const catalog = options.catalog || {};
    const provider = ProviderProfiles?.getProviderById
      ? ProviderProfiles.getProviderById(catalog, snapshot.providerId)
      : (catalog.providers || []).find(item => item?.id === snapshot.providerId);
    if (!provider) throw Codec.snapshotError('provider_not_found', 'The selected provider no longer exists.');
    const currentRevision = Codec.normalizeRevision(provider.revision);
    if (!currentRevision) throw Codec.snapshotError('provider_revision_conflict', 'The selected provider has no usable revision.');
    if (!snapshot.providerRevision) {
      if (snapshot.source !== 'legacy-inferred') {
        throw Codec.snapshotError('provider_revision_conflict', 'The selected provider revision was not captured for this run.');
      }
      return Codec.normalizeSnapshot({ ...snapshot, providerRevision: currentRevision }, {
        source: 'legacy-inferred',
        requireProviderRevision: true
      });
    }
    if (snapshot.providerRevision !== currentRevision) {
      throw Codec.snapshotError('provider_revision_conflict', 'The selected provider changed after this run was submitted.');
    }
    return Codec.normalizeSnapshot(snapshot, { source: snapshot.source, requireProviderRevision: true });
  }

  function snapshotOf(value = {}) {
    const persisted = value.executionSnapshot || value;
    return Codec.normalizeSnapshot(persisted, { source: persisted.source || 'submitted' });
  }

  function cloneSnapshot(value = {}) {
    const snapshot = snapshotOf(value);
    return { ...snapshot, focusFiles: [...snapshot.focusFiles] };
  }

  function toLegacyQueueTuple(value = {}) {
    const snapshot = snapshotOf(value);
    return {
      mode: snapshot.mode,
      providerId: snapshot.providerId,
      providerRevision: snapshot.providerRevision,
      model: snapshot.model,
      reasoningEffort: snapshot.reasoningEffort,
      speedTier: snapshot.speedTier,
      autoRecompile: snapshot.autoRecompile,
      requireReviewing: snapshot.requireReviewing,
      focusFiles: [...snapshot.focusFiles]
    };
  }

  function toQueuePayload(value = {}) {
    const snapshot = snapshotOf(value);
    return { executionSnapshot: cloneSnapshot(snapshot), ...toLegacyQueueTuple(snapshot) };
  }

  function toRunCompatibilityTuple(value = {}) {
    const snapshot = snapshotOf(value);
    return {
      ...toLegacyQueueTuple(snapshot),
      providerRevision: snapshot.providerId === 'builtin' ? 0 : Number(snapshot.providerRevision),
      executionSnapshot: cloneSnapshot(snapshot)
    };
  }

  function projectForDisplay(value = {}) {
    const snapshot = snapshotOf(value);
    return {
      providerId: snapshot.providerId,
      model: snapshot.model,
      reasoningEffort: snapshot.reasoningEffort,
      speedTier: snapshot.speedTier,
      mode: snapshot.mode,
      focusFiles: [...snapshot.focusFiles]
    };
  }

  function equalsExecutionConfig(left = {}, right = {}) {
    const leftTuple = toLegacyQueueTuple(left);
    const rightTuple = toLegacyQueueTuple(right);
    return Codec.TUPLE_FIELDS.every(field =>
      JSON.stringify(leftTuple[field]) === JSON.stringify(rightTuple[field])
    );
  }

  function applyToState(state = {}, value = {}) {
    const snapshot = snapshotOf(value);
    return {
      ...state,
      ...toLegacyQueueTuple(snapshot),
      providerRevision: snapshot.providerId === 'builtin' ? 0 : Number(snapshot.providerRevision)
    };
  }

  function toProviderSelection(value = {}) {
    const snapshot = snapshotOf(value);
    return {
      providerId: snapshot.providerId,
      providerRevision: snapshot.providerId === 'builtin' ? 0 : Number(snapshot.providerRevision)
    };
  }

  return {
    SCHEMA_VERSION: Codec.SCHEMA_VERSION,
    TUPLE_FIELDS: Codec.TUPLE_FIELDS,
    applyToState,
    capture,
    captureRawQueueTuple,
    cloneSnapshot,
    create,
    equalsExecutionConfig,
    fromQueuePayload: captureRawQueueTuple,
    normalizeRevision: Codec.normalizeRevision,
    normalizeSnapshot: Codec.normalizeSnapshot,
    projectForDisplay,
    resolveForExecution,
    toLegacyQueueTuple,
    toProviderSelection,
    toQueuePayload,
    toRunCompatibilityTuple,
    validate: Codec.validate
  };
});
