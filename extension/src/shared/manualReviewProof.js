(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./projectFiles'));
  else if (root.CodexOverleafModuleRegistry) root.CodexOverleafModuleRegistry.define('ManualReviewProof', ['ProjectFiles'], factory);
  else root.CodexOverleafManualReviewProof = factory(root.CodexOverleafProjectFiles);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (ProjectFiles) {
  'use strict';

  const LIMITS = Object.freeze({ maxFiles: 100, maxRefsPerFile: 1199, maxRefs: 4096, maxBytes: 256 * 1024 });
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const identity = (value, max = 160) => typeof value === 'string' && value.length > 0
    && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const exactFields = (value, fields) => record(value) && Object.keys(value).length === fields.length
    && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
  const safePath = value => typeof value === 'string' && value.length <= 2048
    && ProjectFiles?.normalizeSafeProjectPath(value) === value && Boolean(value);

  function parseNativeKey(value) {
    if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('native:')) return null;
    try {
      const tuple = JSON.parse(value.slice(7));
      if (!Array.isArray(tuple) || tuple.length !== 5 || !identity(tuple[0], 256)
        || !['insert', 'delete'].includes(tuple[1]) || !Number.isSafeInteger(tuple[2])
        || !Number.isSafeInteger(tuple[3]) || tuple[2] < 0 || tuple[3] < tuple[2]
        || (tuple[1] === 'insert' ? tuple[3] <= tuple[2] : tuple[3] !== tuple[2])
        || typeof tuple[4] !== 'string' || !/^[1-9]\d*:[0-9a-f]{1,8}:[0-9a-f]{1,8}$/.test(tuple[4])
        || value !== 'native:' + JSON.stringify(tuple)) return null;
      const length = Number(tuple[4].split(':')[0]);
      if (!Number.isSafeInteger(length) || (tuple[1] === 'insert' && length !== tuple[3] - tuple[2])) return null;
      return tuple;
    } catch (_error) { return null; }
  }

  function normalize(value) {
    try {
      if (!exactFields(value, ['v', 'id', 'runProjectId', 'accountScopeId', 'files']) || value.v !== 1
        || !identity(value.id) || !identity(value.runProjectId) || !identity(value.accountScopeId)
        || !Array.isArray(value.files) || !value.files.length || value.files.length > LIMITS.maxFiles) return null;
      const paths = new Set(), files = [];
      let refCount = 0;
      for (const file of value.files) {
        if (!exactFields(file, ['path', 'nativeDocId', 'postHash', 'targetKeys', 'preservedKeys'])
          || !safePath(file.path) || paths.has(file.path) || !identity(file.nativeDocId, 256)
          || typeof file.postHash !== 'string' || !/^[0-9a-f]{64}$/i.test(file.postHash)
          || !Array.isArray(file.targetKeys) || !file.targetKeys.length || !Array.isArray(file.preservedKeys)
          || file.targetKeys.length + file.preservedKeys.length > LIMITS.maxRefsPerFile) return null;
        paths.add(file.path);
        const keys = [...file.targetKeys, ...file.preservedKeys];
        refCount += keys.length;
        if (refCount > LIMITS.maxRefs || new Set(keys).size !== keys.length || keys.some(key => !parseNativeKey(key))) return null;
        files.push({ path: file.path, nativeDocId: file.nativeDocId, postHash: file.postHash.toLowerCase(),
          targetKeys: [...file.targetKeys].sort(), preservedKeys: [...file.preservedKeys].sort() });
      }
      const result = { v: 1, id: value.id, runProjectId: value.runProjectId, accountScopeId: value.accountScopeId, files };
      const json = JSON.stringify(result);
      const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : json.length * 2;
      return bytes <= LIMITS.maxBytes ? result : null;
    } catch (_error) { return null; }
  }

  return Object.freeze({ normalize, parseNativeKey, safePath, LIMITS });
});
