(function initCodexOverleafOtWarmMirrorController(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/projectFiles'));
  } else {
    root.CodexOverleafModuleRegistry.define('OtWarmMirrorController', ['ProjectFiles'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function otWarmMirrorControllerFactory(projectFiles) {
  'use strict';

  const OT_POLL_INTERVAL_MS = 1000;
  const OT_PATCH_DEBOUNCE_MS = 500;
  const OT_MAX_PATCH_BATCH = 25;
  const OT_FRESHNESS_MAX_AGE_MS = 30000;
  const OT_MAX_FILE_BYTES = 1024 * 1024;
  const OT_MAX_PENDING_EVENTS = 64;
  const OT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
  const OT_MAX_BATCH_BYTES = 2 * 1024 * 1024;
  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const PAUSE_STATES = new Set(['running', 'writing', 'undoing', 'compiling']);
  const normalizeLiteralPath = projectFiles.normalizeSafeProjectPath;

  function buildPatchFilesRequest({ projectId, events, nativeCompatibility } = {}) {
    const files = [];
    for (const event of Array.isArray(events) ? events : []) {
      if (files.length >= OT_MAX_PATCH_BATCH) {
        break;
      }
      const filePath = normalizeLiteralPath(event?.path);
      if (!filePath || typeof event?.baseHash !== 'string') {
        continue;
      }
      const baseHash = event.baseHash.trim();
      if (!baseHash) {
        continue;
      }
      if (typeof event.nextContent !== 'string') {
        continue;
      }

      const file = {
        path: filePath,
        baseHash,
        nextContent: event.nextContent
      };
      if (isPrimitiveMetadata(event.observedVersion)) {
        file.observedVersion = event.observedVersion;
      }
      if (isPrimitiveMetadata(event.observedAt)) {
        file.observedAt = event.observedAt;
      }
      files.push(file);
    }

    const params = {
      projectId,
      source: 'ot',
      files
    };
    if (isNativeCompatibilityEvidence(nativeCompatibility)) {
      params.nativeCompatibility = nativeCompatibility;
    }

    return {
      method: 'mirror.patchFiles',
      params
    };
  }

  function shouldPauseOtWarmMirror(state) {
    const reason = getPauseStateName(state);
    if (PAUSE_STATES.has(reason)) {
      return { pause: true, reason };
    }
    return { pause: false };
  }

  function canUseOtWarmStart({ enabled, focusFiles, focusFilesAreLiteral = false, mirrorStatus, now = Date.now() } = {}) {
    if (!enabled) {
      return { ok: false, reason: 'disabled' };
    }
    if (!mirrorStatus || mirrorStatus.exists !== true) {
      return { ok: false, reason: 'mirror_missing' };
    }
    if (mirrorStatus.dirty === true) return { ok: false, reason: 'mirror_dirty' };

    if (focusFilesAreLiteral === true && Array.isArray(focusFiles) && focusFiles.some(path => !normalizeLiteralPath(path))) {
      return { ok: false, reason: 'invalid_focus_paths' };
    }
    const normalizedFocusFiles = normalizePaths(focusFiles, focusFilesAreLiteral === true);
    if (!normalizedFocusFiles.length) {
      return { ok: false, reason: 'no_focus_files' };
    }

    const freshFiles = new Set();
    for (const file of Array.isArray(mirrorStatus.otFreshFiles) ? mirrorStatus.otFreshFiles : []) {
      if (file?.state !== 'fresh') {
        continue;
      }
      const age = now - Date.parse(file.observedAt ?? file.lastPatchAt ?? '');
      if (!Number.isFinite(age) || age < 0 || age > OT_FRESHNESS_MAX_AGE_MS) continue;
      const filePath = normalizeLiteralPath(file.path);
      if (filePath) {
        freshFiles.add(filePath);
      }
    }

    if (normalizedFocusFiles.every(filePath => freshFiles.has(filePath))) {
      return {
        ok: true,
        reason: 'ot_focus_fresh',
        focusFiles: normalizedFocusFiles,
        restrictToFocusFiles: true
      };
    }
    return { ok: false, reason: 'missing_ot_fresh_focus' };
  }

  function textBytes(value) {
    const text = String(value || '');
    return encoder ? encoder.encode(text).byteLength : text.length * 3;
  }

  function patchBytes(event) { return textBytes(event.nextContent) + textBytes(event.path) + 512; }

  function queuePatchEvents(queue, events, now = Date.now()) {
    if (!Array.isArray(events) || events.length > OT_MAX_PENDING_EVENTS) return { ok: false, reason: 'ot_queue_limit' };
    const next = Array.isArray(queue) ? queue.slice() : [];
    let bytes = next.reduce((sum, event) => sum + patchBytes(event), 0);
    if (next.length > OT_MAX_PENDING_EVENTS || bytes > OT_MAX_PENDING_BYTES) return { ok: false, reason: 'ot_queue_limit' };
    for (const input of events) {
      const path = normalizeLiteralPath(input?.path);
      const time = typeof input?.observedAt === 'number' ? input.observedAt : Date.parse(input?.observedAt || '');
      if (!path || path.length > 1024 || typeof input?.nextContent !== 'string' ||
          typeof input.baseHash !== 'string' || !input.baseHash || input.baseHash.length > 128) {
        return { ok: false, reason: 'ot_event_invalid' };
      }
      if (!Number.isFinite(time) || now - time < 0 || now - time > OT_FRESHNESS_MAX_AGE_MS) return { ok: false, reason: 'ot_event_expired' };
      if (textBytes(input.nextContent) > OT_MAX_FILE_BYTES) return { ok: false, reason: 'ot_file_limit' };
      const event = { path, baseHash: input.baseHash, nextContent: input.nextContent,
        nextHash: typeof input.nextHash === 'string' && input.nextHash.length <= 128 ? input.nextHash : '',
        observedAt: new Date(time).toISOString() };
      if (isPrimitiveMetadata(input.observedVersion) && String(input.observedVersion).length <= 128) event.observedVersion = input.observedVersion;
      const tail = next[next.length - 1];
      if (tail?.path === path && tail.nextHash && tail.nextHash === event.baseHash) {
        event.baseHash = tail.baseHash;
        bytes -= patchBytes(next.pop());
      }
      if (event.nextHash !== event.baseHash) { next.push(event); bytes += patchBytes(event); }
      if (next.length > OT_MAX_PENDING_EVENTS || bytes > OT_MAX_PENDING_BYTES) return { ok: false, reason: 'ot_queue_limit' };
    }
    return { ok: true, queue: next, bytes };
  }

  function takePatchBatch(queue) {
    let bytes = 0;
    let count = 0;
    while (count < Math.min(queue.length, OT_MAX_PATCH_BATCH)) {
      const size = patchBytes(queue[count]);
      if (bytes + size > OT_MAX_BATCH_BYTES) break;
      bytes += size;
      count += 1;
    }
    return queue.splice(0, count);
  }

  function validatePatchReceipt(events, result = {}, now = Date.now()) {
    if ((Array.isArray(result.skippedFiles) && result.skippedFiles.length) || Number(result.skippedCount || 0) > 0) {
      return { ok: false, reason: 'mirror_patch_skipped' };
    }
    if (!events.length || Number(result.appliedCount) !== events.length || !Array.isArray(result.appliedFiles) ||
        result.appliedFiles.length !== events.length || !result.appliedFiles.every((file, index) =>
          normalizeLiteralPath(file?.path) === events[index].path && (!events[index].nextHash || file.hash === events[index].nextHash))) {
      return { ok: false, reason: 'mirror_patch_invalid_result' };
    }
    if (events.some(event => { const time = Date.parse(event.observedAt);
      return !Number.isFinite(time) || time > now || now - time > OT_FRESHNESS_MAX_AGE_MS;
    })) return { ok: false, reason: 'ot_event_expired' };
    return { ok: true };
  }

  function readOtBridgeStatus(response) {
    if (!response || response.ok === false) return 'unavailable';
    return response.state || response.status || response.result?.state || response.result?.status || 'unavailable';
  }

  function readOtBridgeEvents(response) {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.events)) return response.events;
    if (Array.isArray(response?.result?.events)) return response.result.events;
    return [];
  }

  function readOtBridgeErrorCode(response, fallback) {
    const value = response?.lastErrorCode || response?.reason || response?.error?.code || response?.error || fallback;
    return typeof value === 'string' ? value : fallback;
  }

  function normalizeFailureCode(value, fallback = 'ot_error') {
    const code = typeof value === 'string' ? value : value?.code;
    if (/^[a-z][a-z0-9_]{0,79}$/.test(code || '')) return code;
    if (/page bridge|capability|bridge timed out/i.test(String(code || ''))) return 'ot_bridge_unavailable';
    return fallback;
  }

  function getFailureMessageKey(value) {
    const code = normalizeFailureCode(value);
    if (/bridge|ot_status|ot_events/.test(code)) return 'otFailureBridge';
    if (/missing_ot_text|observer_create|observer_unavailable/.test(code)) return 'otFailureObserver';
    if (code === 'ot_file_limit') return 'otFailureFileLimit';
    if (code === 'ot_queue_limit') return 'otFailureQueueLimit';
    if (code === 'ot_event_expired') return 'otFailureExpired';
    if (/editor|active_path|document/.test(code)) return 'otFailureEditor';
    if (/mirror|hash|baseline/.test(code)) return 'otFailureMirror';
    return 'otFailureGeneric';
  }

  function normalizePath(value) {
    return String(value ?? '')
      .trim()
      .replace(/^@file:/i, '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\/+/, '');
  }

  function normalizePaths(value, literal = false) {
    const seen = new Set();
    const paths = [];
    for (const item of Array.isArray(value) ? value : []) {
      const filePath = literal ? normalizeLiteralPath(item) : normalizePath(item);
      if (!filePath || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      paths.push(filePath);
    }
    return paths;
  }

  function isPrimitiveMetadata(value) {
    return ['string', 'number', 'boolean'].includes(typeof value);
  }

  function isNativeCompatibilityEvidence(value) {
    return value && typeof value === 'object' && typeof value.status === 'string';
  }

  function getPauseStateName(state) {
    if (typeof state === 'string') {
      return state;
    }
    if (!state || typeof state !== 'object') {
      return '';
    }
    for (const key of ['status', 'state', 'phase', 'mode']) {
      if (typeof state[key] === 'string') {
        return state[key];
      }
    }
    for (const pauseState of PAUSE_STATES) {
      if (state[pauseState] === true) {
        return pauseState;
      }
    }
    return '';
  }

  return {
    OT_POLL_INTERVAL_MS,
    OT_PATCH_DEBOUNCE_MS,
    OT_MAX_PATCH_BATCH,
    OT_FRESHNESS_MAX_AGE_MS,
    OT_MAX_FILE_BYTES,
    OT_MAX_PENDING_EVENTS,
    OT_MAX_PENDING_BYTES,
    OT_MAX_BATCH_BYTES,
    queuePatchEvents,
    takePatchBatch,
    validatePatchReceipt,
    normalizeFailureCode,
    readOtBridgeStatus,
    readOtBridgeEvents,
    readOtBridgeErrorCode,
    getFailureMessageKey,
    buildPatchFilesRequest,
    canUseOtWarmStart,
    normalizePath,
    normalizePaths,
    shouldPauseOtWarmMirror
  };
});
