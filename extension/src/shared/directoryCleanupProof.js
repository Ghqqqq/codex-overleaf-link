(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (root.CodexOverleafModuleRegistry) root.CodexOverleafModuleRegistry.define('DirectoryCleanupProof', [], factory);
  else root.CodexOverleafDirectoryCleanupProof = factory();
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';
  const LIMITS = Object.freeze({ maxDirectories: 100, maxBytes: 64 * 1024 });
  const id = (value, max = 160) => typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const path = value => id(value, 2048) && !/[\\]/.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
  const ownerKeys = ['accountScopeId', 'projectId', 'sessionId', 'runId'];
  function normalize(value) {
    if (!value || value.v !== 1 || !ownerKeys.every(key => id(value[key])) || !Array.isArray(value.directories)
      || !value.directories.length || value.directories.length > LIMITS.maxDirectories) return null;
    const directories = [], seen = new Set();
    for (const raw of value.directories) {
      if (raw?.v !== 1 || raw.projectId !== value.projectId || !path(raw.path)
        || typeof raw.nativeFolderId !== 'string' || (raw.nativeFolderId && !id(raw.nativeFolderId, 256))) return null;
      const key = JSON.stringify([raw.path, raw.nativeFolderId]);
      if (seen.has(key)) continue;
      seen.add(key);
      directories.push({ v: 1, projectId: raw.projectId, path: raw.path, nativeFolderId: raw.nativeFolderId,
        // No current producer has an acknowledged server-side creator ID.
        ownershipConfirmed: false, observedAfterCreate: raw.observedAfterCreate === true });
    }
    const result = { v: 1, ...Object.fromEntries(ownerKeys.map(key => [key, value[key]])), directories };
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(result)).length : JSON.stringify(result).length * 2;
    return bytes <= LIMITS.maxBytes ? result : null;
  }
  function merge(owner, previous, directories) {
    const prior = previous == null ? null : normalize(previous);
    if (previous != null && (!prior || ownerKeys.some(key => prior[key] !== owner[key]))) return null;
    const combined = [...(prior?.directories || [])];
    for (const next of directories || []) {
      const index = combined.findIndex(item => item.path === next?.path && item.projectId === next?.projectId
        && (!item.nativeFolderId || item.nativeFolderId === next?.nativeFolderId));
      if (index < 0) combined.push(next); else combined[index] = next;
    }
    return normalize({ v: 1, ...owner, directories: combined });
  }
  return { LIMITS, normalize, merge };
});
