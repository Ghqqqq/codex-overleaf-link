(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafWritingStyle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const REFERENCE_LIMITS = Object.freeze({
    maxSources: 3,
    maxPdfBytes: 20 * 1024 * 1024,
    maxPdfTotalBytes: 40 * 1024 * 1024,
    maxProjectBytes: 4 * 1024 * 1024,
    // Two maximum-sized PDFs plus one project remain below Chrome's
    // 64 MiB message ceiling after Base64 encoding and request metadata.
    maxAttachmentTotalBytes: 44 * 1024 * 1024,
    pdfExtractionTimeoutMs: 90000
  });
  function normalizeSnapshot(value) {
    if (value == null || value.enabled === false) return null;
    if (typeof value !== 'object'
      || typeof value.accountScopeId !== 'string' || !value.accountScopeId || value.accountScopeId.length > 256
      || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.projectId || '')
      || !/^[a-f0-9-]{36}$/i.test(value.version || '')
      || !/^[a-f0-9]{64}$/i.test(value.bundleHash || '')) {
      const error = new Error('The selected writing skill is unavailable. Reopen General settings.');
      error.code = 'writing_style_snapshot_invalid';
      throw error;
    }
    return Object.freeze({ accountScopeId: value.accountScopeId, projectId: value.projectId,
      version: value.version, bundleHash: value.bundleHash.toLowerCase(),
      label: String(value.label || 'Academic writing').slice(0, 160) });
  }
  return { normalizeSnapshot, REFERENCE_LIMITS };
});
