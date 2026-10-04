(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/directoryCleanupProof'));
  else root.CodexOverleafModuleRegistry.define('DirectoryCleanupRecovery', ['DirectoryCleanupProof'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Proof) {
  'use strict';
  const ownerKeys = ['accountScopeId', 'projectId', 'sessionId', 'runId'];
  const key = proof => JSON.stringify([proof.projectId, proof.path, proof.nativeFolderId]);
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
    const checking = new Set();
    const fail = (message, code = 'directory_cleanup_owner_changed') => { throw Object.assign(new Error(message), { code }); };
    const scope = () => ({ projectId: deps.getProjectId(), accountScopeId: deps.getAccountScopeId(), generation: deps.getRouteGeneration?.() });
    function current(owner, expected) {
      const actual = scope(), record = deps.findRunRecord(owner.runId, owner.sessionId);
      if (actual.projectId !== owner.projectId || actual.accountScopeId !== owner.accountScopeId || actual.generation !== owner.generation
        || !record || record.runProjectId !== owner.projectId || record.forkSnapshot
        || (expected !== undefined && JSON.stringify(Proof.normalize(record.pendingDirectoryCleanup)) !== JSON.stringify(expected))) {
        fail('The project, account or directory-recovery record changed.');
      }
      return record;
    }
    function capture(target, result) {
      const directories = collect(result);
      if (!directories.length || !target?.recordId) return null;
      const captured = scope(), owner = { ...captured, sessionId: target.sessionId, runId: target.recordId };
      if (!captured.accountScopeId || !captured.projectId || target.runProjectId !== captured.projectId
        || (target.runAccountScopeId && target.runAccountScopeId !== captured.accountScopeId)) fail('Directory recovery lost its original project or account.');
      const record = current(owner);
      const next = Proof.merge(owner, record.pendingDirectoryCleanup, directories);
      if (!next) fail('Directory recovery exceeded its bounded storage format. Existing evidence was preserved.', 'directory_cleanup_capacity_exceeded');
      record.pendingDirectoryCleanup = next;
      deps.refresh?.(owner.runId);
      return { owner, value: next };
    }
    const persistOptions = runId => ({ requireDurable: true, preserveRunActionPayload: true, reviewRunIds: [runId] });
    async function persist(capture) {
      if (!capture) return;
      const { owner, value } = capture;
      current(owner, value);
      await deps.persist(persistOptions(owner.runId));
      current(owner, value);
      const stored = await deps.readSession(owner.sessionId);
      current(owner, value);
      const saved = Proof.normalize(stored?.runs?.find(run => run.id === owner.runId)?.pendingDirectoryCleanup);
      if (stored?.id !== owner.sessionId || stored.accountScopeId !== owner.accountScopeId || stored.projectId !== owner.projectId
        || JSON.stringify(saved) !== JSON.stringify(value)) fail('Directory recovery was not durably saved. Keep this page open and retry.', 'directory_cleanup_not_persisted');
    }
    async function check(runId) {
      if (deps.getCurrentRun() || deps.canCheck?.() === false || checking.has(runId)) return;
      const sessionId = deps.getState()?.activeSessionId;
      const record = deps.findRunRecord(runId, sessionId), wrapper = Proof.normalize(record?.pendingDirectoryCleanup);
      if (!wrapper || record.forkSnapshot || wrapper.runId !== runId || wrapper.sessionId !== sessionId) return;
      const owner = { ...scope(), sessionId, runId };
      if (ownerKeys.some(field => owner[field] !== wrapper[field])) fail('Directory recovery belongs to another project or account.');
      const assertRead = () => {
        if (deps.getCurrentRun() || deps.canCheck?.() === false || deps.getState()?.activeSessionId !== sessionId) fail('The active run or session changed during directory checking.');
        return current(owner, wrapper);
      };
      assertRead(); checking.add(runId);
      try {
        const result = await deps.callPageBridge('checkCreatedDirectories', { runProjectId: owner.projectId, directories: wrapper.directories });
        const live = assertRead();
        if (!Array.isArray(result?.remaining) || !Array.isArray(result?.removed)) fail('The folder check did not return complete evidence.', 'directory_cleanup_unconfirmed');
        const remainingKeys = new Set(result.remaining.map(key));
        const removedKeys = new Set(result.removed.filter(item => item.alreadyAbsent === true
          && item.verification === 'overleaf-native-tree-and-zip').map(key));
        const originalKeys = new Set(wrapper.directories.map(key));
        if (result.remaining.some(item => !originalKeys.has(key(item))) || result.removed.some(item => !originalKeys.has(key(item)))
          || wrapper.directories.some(item => !remainingKeys.has(key(item)) && !removedKeys.has(key(item)))) {
          fail('The folder check omitted or changed recovery identities.', 'directory_cleanup_unconfirmed');
        }
        const next = result.remaining.length ? Proof.normalize({ ...wrapper, directories: wrapper.directories.filter(item => remainingKeys.has(key(item))) }) : null;
        if (result.remaining.length && !next) fail('The remaining folder evidence is invalid.', 'directory_cleanup_unconfirmed');
        if (next) live.pendingDirectoryCleanup = next; else delete live.pendingDirectoryCleanup;
        try { await persist({ owner, value: next }); }
        catch (error) {
          // Restore only this still-current mutation, never a newer record.
          try { const currentRecord = current(owner, next); currentRecord.pendingDirectoryCleanup = wrapper; } catch (_changed) {}
          throw error;
        }
        deps.notify?.(deps.tx(next ? 'Folders remain for manual review. No folder was deleted by this check.'
          : 'The recorded folders are no longer present. Directory recovery is complete.',
        next ? '文件夹仍待人工检查；本次检查没有删除任何文件夹。' : '记录的文件夹已不再存在；目录收尾检查完成。'),
        { remaining: next?.directories || [], review: result.review || [] });
        return { ok: !next, remaining: next?.directories || [], review: result.review || [], deletedByCheck: false };
      } finally { checking.delete(runId); deps.refresh?.(runId); }
    }
    return { capture, persist, check };
  }
  return { create, collect };
});
