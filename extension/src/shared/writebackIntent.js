(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./undoOperations'));
  else root.CodexOverleafModuleRegistry.define('WritebackIntent', ['UndoOperations'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Undo) {
  'use strict';
  const MAX_BYTES = 300 * 1024;
  const types = new Set(['edit', 'create', 'delete', 'rename', 'move', 'binary-create', 'overwrite-binary']);
  const path = value => typeof value === 'string' && value && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value) && !value.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..');
  function normalize(value) {
    if (!value || typeof value !== 'object' || !value.id || !value.projectId || !value.accountScopeId
      || !value.sessionId || !value.runId || !Array.isArray(value.operations) || value.operations.length > 100) return null;
    const operations = [];
    for (const input of value.operations) {
      if (!types.has(input?.type) || !path(input.path) || (input.to && !path(input.to))) return null;
      const op = { type: input.type, path: input.path };
      for (const key of ['to', 'content', 'replaceAll', 'find', 'replace', 'sha256', 'mimeType']) {
        if (typeof input[key] === 'string') op[key] = input[key];
      }
      if (Number.isSafeInteger(input.size)) op.size = input.size;
      if (Array.isArray(input.patches)) {
        if (input.patches.length > 1000) return null;
        op.patches = input.patches.map(p => ({ from: p.from, to: p.to, expected: String(p.expected ?? ''), insert: String(p.insert ?? '') }));
        if (op.patches.some(p => !Number.isSafeInteger(p.from) || !Number.isSafeInteger(p.to) || p.from < 0 || p.to < p.from)) return null;
      }
      operations.push(op);
    }
    const paths = new Set(operations.flatMap(op => [op.path, op.to].filter(Boolean)));
    const baseFiles = (Array.isArray(value.baseFiles) ? value.baseFiles : [])
      .filter(file => paths.has(file?.path) && typeof file.content === 'string')
      .map(file => ({ path: file.path, content: file.content }));
    const result = { v: 1, id: String(value.id).slice(0, 160), projectId: String(value.projectId).slice(0, 160),
      accountScopeId: String(value.accountScopeId).slice(0, 160), sessionId: String(value.sessionId).slice(0, 160),
      runId: String(value.runId).slice(0, 160), createdAt: String(value.createdAt || '').slice(0, 64),
      requireReviewing: value.requireReviewing === true, operations, baseFiles };
    if (typeof value.requestId === 'string') result.requestId = value.requestId.slice(0, 160);
    const size = typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(result)).length : JSON.stringify(result).length * 2;
    return size <= MAX_BYTES ? result : null;
  }
  function expectedFiles(value) {
    return Undo.buildExpectedFilesAfterOperations({ files: value.baseFiles }, value.operations.filter(op => !op.type.includes('binary')));
  }
  function normalizeSaveCheck(value) {
    if (!value?.projectId || !value.accountScopeId || !value.sessionId || !value.runId
      || !Array.isArray(value.files) || value.files.length > 1000) return null;
    const files = [];
    for (const file of value.files) {
      if (!path(file?.path)) return null;
      if (file.absent === true) files.push({ path: file.path, absent: true });
      else if (/^[a-f0-9]{64}$/i.test(file.sha256 || '')) {
        if (file.kind !== undefined && !['text', 'binary'].includes(file.kind)) return null;
        files.push({ path: file.path, sha256: file.sha256.toLowerCase(),
          ...(file.kind ? { kind: file.kind } : {}) });
      }
      else return null;
    }
    return files.length ? { v: 1, projectId: String(value.projectId).slice(0, 160),
      accountScopeId: String(value.accountScopeId).slice(0, 160), sessionId: String(value.sessionId).slice(0, 160),
      runId: String(value.runId).slice(0, 160), createdAt: String(value.createdAt || '').slice(0, 64), files } : null;
  }
  return { normalize, normalizeSaveCheck, expectedFiles, MAX_BYTES };
});
