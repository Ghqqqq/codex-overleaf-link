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
      if (input.moveProof !== undefined) {
        const proof = input.moveProof;
        if (input.type !== 'move' || proof?.v !== 1 || !['text', 'binary'].includes(proof.kind)
          || !/^[a-f0-9]{64}$/i.test(proof.sha256 || '')) return null;
        op.moveProof = { v: 1, kind: proof.kind, sha256: proof.sha256.toLowerCase() };
        if (proof.entityType !== undefined) {
          if (!['doc', 'file'].includes(proof.entityType)) return null;
          op.moveProof.entityType = proof.entityType;
        }
        for (const key of ['sourceEntityId', 'targetEntityId']) {
          if (proof[key] !== undefined) {
            if (typeof proof[key] !== 'string' || !proof[key] || proof[key].length > 160 || /[\0\r\n]/.test(proof[key])) return null;
            op.moveProof[key] = proof[key];
          }
        }
      }
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
  function normalizeWritebackCheck(value) {
    if (value?.v !== 1 || value.purpose !== 'writeback-revalidation' || !Array.isArray(value.files)
      || !value.files.length || value.files.length > 1000) return null;
    const result = { v: 1, purpose: 'writeback-revalidation' };
    for (const key of ['id', 'projectId', 'accountScopeId', 'sessionId', 'runId']) {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 160 || /[\u0000-\u001f\u007f]/.test(value[key])) return null;
      result[key] = value[key];
    }
    if (typeof value.createdAt !== 'string' || value.createdAt.length > 64 || !Number.isFinite(Date.parse(value.createdAt))) return null;
    result.createdAt = value.createdAt;
    const seen = new Set();
    result.files = [];
    for (const file of value.files) {
      if (!path(file?.path) || file.path.length > 1024 || /[\u0000-\u001f\u007f]/.test(file.path) || seen.has(file.path)) return null;
      seen.add(file.path);
      if (file.absent === true) result.files.push({ path: file.path, absent: true });
      else if (['text', 'binary'].includes(file.kind) && /^[a-f0-9]{64}$/i.test(file.sha256 || '')) {
        result.files.push({ path: file.path, kind: file.kind, sha256: file.sha256.toLowerCase() });
      } else return null;
    }
    if (typeof value.checkedAt === 'string' && value.checkedAt.length <= 64 && Number.isFinite(Date.parse(value.checkedAt))
      && ['matches', 'differs', 'unavailable'].includes(value.observation)) {
      result.checkedAt = value.checkedAt; result.observation = value.observation;
    }
    const bytes = typeof TextEncoder === 'function' ? new TextEncoder().encode(JSON.stringify(result)).length : JSON.stringify(result).length * 2;
    return bytes <= 256 * 1024 ? result : null;
  }
  return { normalize, normalizeSaveCheck, normalizeWritebackCheck, expectedFiles, MAX_BYTES };
});
