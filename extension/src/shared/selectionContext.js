(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('SelectionContext', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';
  const MAX_TEXT = 20000;
  function normalize(value) {
    if (!value || typeof value !== 'object') return null;
    const path = typeof value.path === 'string' ? value.path.replace(/\\/g, '/') : '';
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')) return null;
    if (typeof value.projectId !== 'string' || !value.projectId
      || typeof value.text !== 'string' || !value.text.length || value.text.length > MAX_TEXT
      || !Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to)
      || value.from < 0 || value.to <= value.from || value.to - value.from !== value.text.length
      || !/^[a-f0-9]{64}$/i.test(value.documentHash || '')) return null;
    return Object.freeze({
      projectId: value.projectId.slice(0, 160), path: path.slice(0, 320),
      from: value.from, to: value.to, text: value.text,
      lineStart: Number.isSafeInteger(value.lineStart) && value.lineStart > 0 ? value.lineStart : 1,
      lineEnd: Number.isSafeInteger(value.lineEnd) && value.lineEnd > 0 ? value.lineEnd : 1,
      documentHash: value.documentHash.toLowerCase(),
      mode: value.mode === 'edit' ? 'edit' : 'reference',
      capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt.slice(0, 64) : ''
    });
  }
  return { normalize, MAX_TEXT };
});
