(function initCodexOverleafRunSettlementPersistence(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafRunSettlementPersistence = api;
})(typeof window !== 'undefined' ? window : globalThis, function runSettlementPersistenceFactory() {
  'use strict';

  function create(options = {}) {
    const Settlement = options.writebackSettlement;

    function findTarget(recordId, sessionId) {
      return typeof options.findRunRecord === 'function'
        ? options.findRunRecord(recordId, sessionId)
        : null;
    }

    function applyToCurrentRun(settlement) {
      const view = options.getCurrentRunView?.();
      if (!settlement || !view?.recordId) return;
      const record = findTarget(view.recordId, view.sessionId);
      if (!record) return;
      Object.assign(record, Settlement.applySettlementTransition(record, settlement));
    }

    function settleMirrorRefresh(result = {}) {
      const record = findTarget(result.recordId, result.sessionId);
      if (!record) return;
      if (result.runProjectId && result.runProjectId !== options.getCurrentProjectId?.()) return;
      const existing = record.settlement && typeof record.settlement === 'object'
        ? record.settlement
        : record.settlementFacts;
      if (!existing || typeof existing !== 'object') return;
      record.settlement = Settlement.compactSettlementFacts({
        ...existing,
        evidence: {
          ...(existing.evidence || {}),
          mirrored: result.state
        }
      });
      delete record.settlementFacts;
      options.saveStateSoon?.();
    }

    return Object.freeze({
      applyToCurrentRun,
      settleMirrorRefresh
    });
  }

  return Object.freeze({ create });
});
