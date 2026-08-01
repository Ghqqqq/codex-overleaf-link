(function initCodexOverleafRunExecutionSnapshotCodec(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafRunExecutionSnapshotCodec = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function runExecutionSnapshotCodecFactory() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const VALID_MODES = new Set(['ask', 'auto']);
  const VALID_SOURCES = new Set(['submitted', 'legacy-captured', 'legacy-inferred']);
  const TUPLE_FIELDS = Object.freeze([
    'mode', 'providerId', 'providerRevision', 'model', 'reasoningEffort',
    'speedTier', 'autoRecompile', 'requireReviewing', 'focusFiles'
  ]);
  const SECRET_FIELD_PATTERN = /(?:api.?key|authorization|password|secret|access.?token|refresh.?token)/i;

  function normalizeSnapshot(value = {}, options = {}) {
    const input = value && typeof value === 'object' ? value : {};
    assertNoSecretFields(input);
    if (input.mode === 'confirm' && options.migrateLegacyConfirm !== true) {
      throw snapshotError('suggest_mode_removed', 'Suggest mode has been removed. Choose Ask or Auto.');
    }
    const providerId = normalizeText(input.providerId) || 'builtin';
    const revision = normalizeRevisionResult(input.providerRevision);
    if (!revision.ok) throw snapshotError('provider_revision_conflict', revision.error);
    const snapshot = {
      schemaVersion: SCHEMA_VERSION,
      mode: input.mode === 'auto' ? 'auto' : 'ask',
      providerId,
      providerRevision: providerId === 'builtin' ? '' : revision.value,
      model: normalizeText(input.model).slice(0, 160),
      reasoningEffort: normalizeText(input.reasoningEffort).slice(0, 32),
      speedTier: input.speedTier === 'fast' ? 'fast' : 'standard',
      autoRecompile: input.autoRecompile !== false,
      requireReviewing: input.requireReviewing !== false,
      focusFiles: normalizePaths(input.focusFiles),
      capturedAt: normalizeTimestamp(input.capturedAt),
      source: VALID_SOURCES.has(options.source || input.source)
        ? (options.source || input.source)
        : 'submitted'
    };
    const result = validate(snapshot, options);
    if (!result.ok) throw snapshotError(result.errors[0].code, result.errors[0].message);
    snapshot.focusFiles = Object.freeze([...snapshot.focusFiles]);
    return Object.freeze(snapshot);
  }

  function validate(value = {}, options = {}) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail('invalid_execution_snapshot', 'Execution snapshot must be an object.');
    }
    if (value.schemaVersion !== undefined && Number(value.schemaVersion) !== SCHEMA_VERSION) {
      errors.push(errorItem('invalid_execution_snapshot', `Unsupported execution snapshot schema version: ${value.schemaVersion}`));
    }
    if (!VALID_MODES.has(value.mode)) {
      errors.push(errorItem('invalid_execution_snapshot', 'Execution snapshot mode is invalid.'));
    }
    const providerId = normalizeText(value.providerId);
    if (!providerId) errors.push(errorItem('invalid_execution_snapshot', 'Execution snapshot provider is missing.'));
    const revision = normalizeRevisionResult(value.providerRevision);
    if (!revision.ok) {
      errors.push(errorItem('provider_revision_conflict', revision.error));
    } else if (providerId === 'builtin' && revision.value) {
      errors.push(errorItem('provider_revision_conflict', 'Built-in Codex cannot carry a provider revision.'));
    } else if (providerId !== 'builtin' && options.requireProviderRevision === true && !revision.value) {
      errors.push(errorItem('provider_revision_conflict', 'The selected provider revision was not available when the run was submitted.'));
    }
    if (!Array.isArray(value.focusFiles) || value.focusFiles.length > 100) {
      errors.push(errorItem('invalid_execution_snapshot', 'Execution snapshot focus files are invalid.'));
    }
    try {
      assertNoSecretFields(value);
    } catch (error) {
      errors.push(errorItem(error.code, error.message));
    }
    return { ok: errors.length === 0, errors };
  }

  function normalizeRevision(value) {
    const result = normalizeRevisionResult(value);
    return result.ok ? result.value : '';
  }

  function normalizeRevisionResult(value) {
    if (value === undefined || value === null || value === '') return { ok: true, value: '' };
    const text = typeof value === 'string' ? value.trim() : String(value);
    if (!text) return { ok: true, value: '' };
    const number = Number(text);
    return Number.isSafeInteger(number) && number >= 0
      ? { ok: true, value: String(number) }
      : { ok: false, value: '', error: 'Provider revision must be a finite non-negative integer.' };
  }

  function normalizePaths(value) {
    const seen = new Set();
    const result = [];
    for (const raw of Array.isArray(value) ? value : []) {
      const path = normalizeProjectPath(raw);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      result.push(path);
      if (result.length >= 100) break;
    }
    return result;
  }

  function normalizeProjectPath(value) {
    const result = [];
    for (const segment of String(value || '').replace(/\0/g, '').replace(/\\/g, '/').replace(/^\/+/, '').split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..') return '';
      result.push(segment);
    }
    return result.join('/').trim();
  }

  function normalizeTimestamp(value) {
    if (typeof value === 'string' && value) return value;
    if (Number.isFinite(Number(value)) && Number(value) > 0) return new Date(Number(value)).toISOString();
    return new Date().toISOString();
  }

  function assertNoSecretFields(value) {
    for (const key of Object.keys(value && typeof value === 'object' ? value : {})) {
      if (SECRET_FIELD_PATTERN.test(key)) {
        throw snapshotError('invalid_execution_snapshot', `Execution snapshot cannot contain secret field "${key}".`);
      }
    }
  }

  function cloneValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function snapshotError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function errorItem(code, message) {
    return { code, message };
  }

  function fail(code, message) {
    return { ok: false, errors: [errorItem(code, message)] };
  }

  return {
    SCHEMA_VERSION,
    TUPLE_FIELDS,
    cloneValue,
    hasOwn,
    normalizeRevision,
    normalizeSnapshot,
    normalizeText,
    snapshotError,
    validate
  };
});
