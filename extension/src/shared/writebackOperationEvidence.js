(function initCodexOverleafWritebackOperationEvidence(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafModuleRegistry.define('WritebackOperationEvidence', [], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function writebackOperationEvidenceFactory() {
  'use strict';

  function normalizeOperationEvidence(operations = [], applyResult = {}) {
    const planned = Array.isArray(operations) ? operations : [];
    const entries = [];
    const claimedPlanned = new Set();
    let fallbackCursor = 0;

    const operationKey = operation => {
      if (!operation || typeof operation !== 'object') return '';
      return normalizeText(operation.id)
        || [
          normalizeText(operation.type),
          normalizeText(operation.path || operation.from),
          normalizeText(operation.to || operation.destinationPath),
          Number.isFinite(Number(operation.sequence)) ? Number(operation.sequence) : ''
        ].join(':');
    };

    const claimPlannedOperation = explicitOperation => {
      if (explicitOperation && typeof explicitOperation === 'object') {
        const explicitKey = operationKey(explicitOperation);
        const matchedIndex = planned.findIndex((operation, plannedIndex) =>
          !claimedPlanned.has(plannedIndex) && operationKey(operation) === explicitKey
        );
        if (matchedIndex >= 0) claimedPlanned.add(matchedIndex);
        return explicitOperation;
      }
      while (claimedPlanned.has(fallbackCursor)) fallbackCursor++;
      if (fallbackCursor >= planned.length) return {};
      const operation = planned[fallbackCursor];
      claimedPlanned.add(fallbackCursor);
      fallbackCursor++;
      return operation;
    };

    const push = (entry, collection, index) => {
      const operation = claimPlannedOperation(entry?.operation);
      const result = entry?.result || entry || {};
      const failure = normalizeFailure(result, operation);
      const changedDocument = result.changedDocument === true
        || (collection === 'applied' && result.ok !== false);
      const mayHaveMutated = changedDocument
        || result.mayHaveMutated === true
        || failure?.changedDocument === true;
      entries.push({
        operationId: normalizeText(operation.id) || `${collection}:${index}:${operation.type || 'unknown'}:${operation.path || operation.to || ''}`,
        sequence: Number.isFinite(Number(operation.sequence)) ? Number(operation.sequence) : index,
        path: normalizeText(operation.path || operation.from),
        targetPath: normalizeText(operation.to || operation.destinationPath),
        kind: normalizeText(operation.type) || 'unknown',
        collection,
        ok: result.ok !== false,
        changedDocument,
        mayHaveMutated,
        failureCodes: failure?.code ? [failure.code] : [],
        failures: failure ? [failure] : [],
        trackedChanges: normalizeTrackedChanges(result.trackedChanges || entry?.trackedChanges),
        undoIds: normalizeStringArray(result.undoIds || entry?.undoIds),
        baseAvailable: operation.baseContent !== undefined || operation.expected !== undefined,
        expectedAvailable: operation.expected !== undefined || result.verifiedContent !== undefined
      });
    };
    (Array.isArray(applyResult?.applied) ? applyResult.applied : [])
      .forEach((entry, index) => push(entry, 'applied', index));
    (Array.isArray(applyResult?.skipped) ? applyResult.skipped : [])
      .forEach((entry, index) => push(entry, 'skipped', index));
    planned.forEach((operation, index) => {
      if (claimedPlanned.has(index)) return;
      const path = normalizeText(operation?.path || operation?.from || operation?.to);
      push({
        operation,
        result: {
          ok: false,
          mayHaveMutated: false,
          failure: {
            code: 'write_result_missing',
            stage: 'write',
            severity: 'error',
            userMessage: `No write result was returned for ${path || 'a planned operation'}.`,
            retryable: true,
            nextAction: 'Retry the task and review the Overleaf document before continuing.',
            file: path,
            operationType: normalizeText(operation?.type),
            changedDocument: false,
            terminalState: 'needs_review'
          }
        }
      }, 'skipped', index);
    });
    return entries;
  }

  function normalizeFailure(result, operation) {
    if (result?.failure && typeof result.failure === 'object') return cloneValue(result.failure);
    if (!result?.code) return null;
    return {
      code: result.code,
      stage: result.stage || 'write',
      severity: result.severity || 'error',
      userMessage: result.reason || result.message || result.code,
      retryable: result.retryable === true,
      file: operation?.path || operation?.to || '',
      changedDocument: result.changedDocument === true,
      terminalState: result.terminalState || ''
    };
  }

  function normalizeTrackedChanges(value) {
    return (Array.isArray(value) ? value : []).map(item => ({
      key: normalizeText(item?.key),
      id: normalizeText(item?.id),
      path: normalizeText(item?.path),
      label: normalizeText(item?.label)
    })).filter(item => item.key || item.id || item.path);
  }

  function normalizeStringArray(value) {
    return (Array.isArray(value) ? value : []).map(normalizeText).filter(Boolean);
  }

  function cloneValue(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  return {
    normalizeFailure,
    normalizeOperationEvidence,
    normalizeTrackedChanges
  };
});
