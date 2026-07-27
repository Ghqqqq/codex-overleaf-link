(function initPostNavigationSettlementPersistence(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafPostNavigationSettlementPersistence = api;
})(typeof window !== 'undefined' ? window : globalThis, function postNavigationSettlementPersistenceFactory() {
  'use strict';

  async function persist(options = {}) {
    if (options.__insideScopedTransaction !== true) {
      const accountScopeId = String(options.accountScopeId || '').trim();
      const projectId = String(options.projectId || '').trim();
      if (!accountScopeId) {
        return { ok: false, reason: 'account_scope_unavailable' };
      }
      if (!projectId) {
        return { ok: false, reason: 'project_scope_unavailable' };
      }
      if (!options.PersistenceCoordinator
        || typeof options.PersistenceCoordinator.commitDetached !== 'function') {
        return { ok: false, reason: 'scoped_persistence_unavailable' };
      }
      return options.PersistenceCoordinator.commitDetached(
        projectId,
        accountScopeId,
        { rebase: true },
        () => persist({
          ...options,
          __insideScopedTransaction: true
        })
      );
    }
    const {
      StorageDb,
      WritebackSettlement,
      sessionId,
      runId,
      status,
      statusText,
      finishedAt,
      settlementResult
    } = options;
    if (!StorageDb || !WritebackSettlement || !sessionId || !runId || !status) {
      return { ok: false, reason: 'invalid_post_navigation_settlement' };
    }
    const record = await StorageDb.getRecord('sessions', sessionId);
    if (!record) return { ok: false, reason: 'session_not_found' };
    if (String(record.accountScopeId || '').trim() !== String(options.accountScopeId || '').trim()) {
      return { ok: false, reason: 'account_scope_mismatch' };
    }
    if (String(record.projectId || '').trim() !== String(options.projectId || '').trim()) {
      return { ok: false, reason: 'project_scope_mismatch' };
    }
    const runs = Array.isArray(record.runs) ? [...record.runs] : [];
    const runIndex = runs.findIndex(run => run && run.id === runId);
    if (runIndex < 0) return { ok: false, reason: 'run_not_found' };

    let transitioned = settlementResult
      ? WritebackSettlement.applySettlementTransition(runs[runIndex], settlementResult)
      : { ...runs[runIndex] };
    transitioned = WritebackSettlement.applySettlementTransition(
      transitioned,
      WritebackSettlement.transitionPostNavigationStatus({
        status,
        statusText,
        finishedAt: finishedAt || transitioned.finishedAt || new Date().toISOString()
      })
    );
    runs[runIndex] = transitioned;

    const now = options.now || new Date().toISOString();
    record.runs = runs;
    record.lastActivityAt = now;
    record.updatedAt = now;
    await StorageDb.putRecord('sessions', record);
    return { ok: true, run: transitioned };
  }

  async function persistRequired(options = {}) {
    const result = await persist(options);
    if (result?.ok === true) return result;
    const reason = String(result?.reason || 'unknown_failure');
    throw Object.assign(
      new Error(`Post-navigation settlement persistence failed: ${reason}`),
      {
        code: 'post_navigation_settlement_persistence_failed',
        reason
      }
    );
  }

  return Object.freeze({ persist, persistRequired });
});
