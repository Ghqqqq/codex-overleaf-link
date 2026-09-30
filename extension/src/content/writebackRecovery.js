(function (root, factory) {
  root.CodexOverleafModuleRegistry.define('WritebackRecovery', ['WritebackIntent', 'UndoOperations'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function (Intent, Undo) {
  'use strict';
  function create(deps) {
    let recovery = null;
    const owner = () => ({ projectId: deps.getProjectId(), accountScopeId: deps.getAccountScopeId() });
    const current = scope => scope.projectId === deps.getProjectId() && scope.accountScopeId === deps.getAccountScopeId();
    const runs = () => (deps.getState()?.sessions || []).flatMap(session => (session.runs || []).map(run => ({ session, run })));
    async function prepare(input) {
      const view = deps.getRun(), scope = owner();
      const run = view && deps.findRun(view.recordId, view.sessionId);
      if (!run || !scope.accountScopeId || input.runProjectId !== scope.projectId
        || view.runProjectId !== scope.projectId) throw new Error('Writeback ownership changed before dispatch.');
      const pending = Intent.normalize({
        ...scope, id: crypto.randomUUID(), sessionId: view.sessionId, runId: run.id,
        createdAt: new Date().toISOString(), operations: input.operations, baseFiles: input.baseFiles,
        requireReviewing: input.requireReviewing
      });
      if (!pending) throw new Error('This change exceeds the recoverable writeback limit. Split it into smaller changes.');
      for (const op of pending.operations) {
        if (op.type === 'edit' && !pending.baseFiles.some(file => file.path === op.path)) {
          throw new Error('The original content of ' + op.path + ' is unavailable. Refresh the project before writing.');
        }
      }
      run.pendingWriteback = pending;
      await deps.save();
      if (!current(scope)) throw new Error('Project changed before writeback dispatch.');
      const stored = await deps.StorageDb.getRecord('sessions', view.sessionId);
      if (stored?.accountScopeId !== scope.accountScopeId || stored?.projectId !== scope.projectId
        || !(stored.runs || []).some(item => item.id === run.id && item.pendingWriteback?.id === pending.id)) {
        throw new Error('The writeback recovery record could not be saved. No write was dispatched.');
      }
      return pending.id;
    }
    async function settle(input, result) {
      const view = deps.getRun(), run = view && deps.findRun(view.recordId, view.sessionId);
      if (!run?.pendingWriteback || run.pendingWriteback.projectId !== input.runProjectId) return;
      const uncertain = result?.receiptUnconfirmed === true || (result?.skipped || []).some(entry => {
        const item = entry.result || entry; return item.changedDocument === true || item.failure?.changedDocument === true;
      });
      // Volatile marker only. The intent remains durable until the mature
      // action checkpoint has been recorded by the orchestrator.
      run.writebackResultKnown = !uncertain;
    }
    function checkpointRecorded(run) {
      if (run?.writebackResultKnown === true) {
        delete run.pendingWriteback; delete run.writebackResultKnown;
      }
    }
    async function recover() {
      if (recovery) return recovery;
      recovery = reconcile().finally(() => { recovery = null; });
      return recovery;
    }
    async function reconcile() {
      if (deps.getRun()) return false;
      const scope = owner();
      const pending = runs().filter(({ run }) => run.pendingWriteback
        && run.pendingWriteback.projectId === scope.projectId && run.pendingWriteback.accountScopeId === scope.accountScopeId);
      if (!pending.length) return true;
      const snapshot = await deps.readProject();
      if (!current(scope) || !snapshot?.capabilities?.fullProjectSnapshot) return false;
      const observed = new Map((snapshot.files || []).map(file => [file.path, file]));
      for (const { session, run } of pending) {
        const intent = Intent.normalize(run.pendingWriteback);
        if (!intent || intent.sessionId !== session.id || intent.runId !== run.id) continue;
        const before = new Map(intent.baseFiles.map(file => [file.path, file.content]));
        const after = Intent.expectedFiles(intent);
        const applied = [], untouched = [], unknown = [];
        for (const operation of intent.operations) {
          const paths = [operation.path, operation.to].filter(Boolean);
          if (operation.type.includes('binary')) {
            unknown.push(operation.path); continue;
          }
          const matches = map => paths.every(path => map.has(path)
            ? typeof observed.get(path)?.content === 'string' && observed.get(path).content === map.get(path)
            : !observed.has(path));
          if (matches(before)) untouched.push(operation.path);
          else if (matches(after)) applied.push(operation);
          else unknown.push(operation.path);
        }
        if (!current(scope)) return false;
        const retained = Array.isArray(run.appliedOperations) ? run.appliedOperations : [];
        const knownPaths = new Set(retained.map(op => op.path));
        run.appliedOperations = [...retained, ...applied.filter(op => !knownPaths.has(op.path))];
        if (applied.length) {
          run.changedDocument = true;
          if (intent.requireReviewing) {
            // Text readback cannot recreate native tracked-change identities.
            // Preserve real refs if already captured; never fabricate Accept.
            run.undoExpectedFiles = intent.baseFiles;
            run.trackedChangeStatus = ['accepted', 'rejected'].includes(run.trackedChangeStatus)
              ? run.trackedChangeStatus : 'needs_review';
          } else {
            const undo = Undo.buildUndoCheckpoint({ files: intent.baseFiles }, run.appliedOperations);
            run.undoOperations = undo.undoOperations; run.undoBaseFiles = undo.undoBaseFiles;
            run.undoExpectedFiles = intent.baseFiles;
          }
        }
        if (!unknown.length) delete run.pendingWriteback;
        run.status = applied.length || unknown.length ? 'needs_review_after_navigation' : 'interrupted';
        run.statusText = deps.tx('Writeback checked after refresh', '已核对刷新前的写入');
        const text = deps.tx(
          'Writeback recovery: ' + applied.length + ' confirmed changed, ' + untouched.length + ' unchanged, ' + unknown.length + ' require inspection.',
          '写入核对：' + applied.length + ' 项已确认修改，' + untouched.length + ' 项未修改，' + unknown.length + ' 项需要检查。'
        );
        run.events = [...(run.events || []).filter(event => event.recoveryIntentId !== intent.id), {
          kind: 'activity', title: text, status: unknown.length ? 'warning' : 'completed',
          timestamp: new Date().toISOString(), recoveryIntentId: intent.id,
          activity: { v: 1, kind: 'notice', id: 'writeback-recovery:' + intent.id, state: unknown.length ? 'warning' : 'info' }
        }].slice(-300);
        session.updatedAt = new Date().toISOString();
      }
      await deps.save();
      if (current(scope)) deps.refresh();
      return !runs().some(({ run }) => run.pendingWriteback?.projectId === scope.projectId);
    }
    return { prepare, settle, checkpointRecorded, recover };
  }
  return { create };
});
