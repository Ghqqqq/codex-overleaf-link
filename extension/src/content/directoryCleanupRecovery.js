(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/directoryCleanupProof'));
  else root.CodexOverleafModuleRegistry.define('DirectoryCleanupRecovery', ['DirectoryCleanupProof'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Proof) {
  'use strict';
  function collect(result) {
    const proofs = [], seen = new Set();
    const safePath = path => typeof path === 'string' && path && path.trim() === path
      && !/[\\\u0000-\u001f\u007f]/.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
      && !path.split('/').some(part => !part || part === '.' || part === '..');
    function visit(value) {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const operation = value.operation, detail = value.result;
      if (operation && detail && safePath(operation.path)) {
        const remaining = Array.isArray(detail.directoryCleanup?.remaining) ? detail.directoryCleanup.remaining
          : detail.ok !== true && Array.isArray(detail.createdDirectories) ? detail.createdDirectories : [];
        // Forward moves may create destination parents; inverse moves can
        // leave source parents behind. Other operations authorize path only.
        const targets = [operation.path, ...(operation.type === 'move' && safePath(operation.to) ? [operation.to] : [])];
        for (const proof of remaining) if (safePath(proof?.path)
          && targets.some(target => target.startsWith(proof.path + '/'))) proofs.push(proof);
      }
      for (const field of ['applied', 'skipped']) visit(value[field]);
    }
    visit(result);
    return proofs;
  }
  function create(deps) {
    const scope = () => ({ projectId: deps.getProjectId(), accountScopeId: deps.getAccountScopeId(), generation: deps.getRouteGeneration?.() });
    function capture(target, result) {
      const directories = collect(result);
      if (!directories.length || !target?.recordId) return null;
      const captured = scope(), owner = { ...captured, sessionId: target.sessionId, runId: target.recordId };
      if (!captured.accountScopeId || !captured.projectId || target.runProjectId !== captured.projectId
        || (target.runAccountScopeId && target.runAccountScopeId !== captured.accountScopeId)) return null;
      const record = deps.findRunRecord(owner.runId, owner.sessionId);
      if (!record || record.runProjectId !== owner.projectId || record.forkSnapshot) return null;
      const next = Proof.merge(owner, record.pendingDirectoryCleanup, directories);
      if (!next) {
        // These passive observations never hold a verified file result hostage.
        // Preserve older evidence and report the omission in existing run details.
        deps.onOmitted?.(owner.runId, 'directory_cleanup_capacity_exceeded');
        return null;
      }
      record.pendingDirectoryCleanup = next;
      deps.refresh?.(owner.runId);
      return { owner, value: next };
    }
    return { capture };
  }
  return { create, collect };
});
