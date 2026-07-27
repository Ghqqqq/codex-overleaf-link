(function initCodexOverleafWritebackEvidenceProjection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafWritebackEvidenceProjection = api;
})(typeof window !== 'undefined' ? window : globalThis, function writebackEvidenceProjectionFactory() {
  'use strict';

  function aggregateFileSettlements(operationEvidence = [], readbacks = []) {
    const byPath = new Map();
    const byRelatedPath = new Map();
    for (const evidence of operationEvidence) {
      const key = evidence.path || evidence.targetPath || 'unknown file';
      if (!byPath.has(key)) {
        byPath.set(key, {
          path: key,
          operationIds: [],
          relatedPaths: [],
          applied: 'none',
          documentEffect: 'unchanged',
          readBack: 'unknown',
          recoveryKind: '',
          failureCodes: [],
          operationCount: 0,
          appliedCount: 0,
          failedCount: 0
        });
      }
      const file = byPath.get(key);
      file.operationCount++;
      file.operationIds.push(evidence.operationId);
      if (evidence.targetPath && evidence.targetPath !== key && !file.relatedPaths.includes(evidence.targetPath)) {
        file.relatedPaths.push(evidence.targetPath);
        byRelatedPath.set(evidence.targetPath, file);
      }
      if (evidence.collection === 'applied' && evidence.ok !== false) file.appliedCount++;
      if (evidence.collection !== 'applied' || evidence.ok === false) file.failedCount++;
      if (evidence.changedDocument) file.documentEffect = 'changed';
      else if (evidence.mayHaveMutated && file.documentEffect !== 'changed') file.documentEffect = 'possible';
      for (const code of evidence.failureCodes) {
        if (!file.failureCodes.includes(code)) file.failureCodes.push(code);
      }
    }
    for (const readback of normalizeFileReadbackEvidence(readbacks)) {
      const file = byPath.get(readback.path) || byRelatedPath.get(readback.path);
      if (!file) continue;
      const deletesPath = operationEvidence.some(evidence =>
        evidence.kind === 'delete' && evidence.path === readback.path
      );
      file.readBack = deletesPath && readback.state === 'missing' ? 'match' : readback.state;
      if (file.readBack === 'mismatch') {
        file.documentEffect = file.documentEffect === 'unchanged' ? 'possible' : file.documentEffect;
        if (!file.failureCodes.includes('write_observed_mismatch')) {
          file.failureCodes.push('write_observed_mismatch');
        }
      }
    }
    return Array.from(byPath.values()).map(file => {
      file.applied = file.appliedCount === file.operationCount
        ? 'complete'
        : file.appliedCount > 0
          ? 'partial'
          : file.failedCount > 0
            ? 'failed'
            : 'none';
      delete file.operationCount;
      delete file.appliedCount;
      delete file.failedCount;
      return file;
    }).sort((left, right) => left.path.localeCompare(right.path));
  }

  function normalizeFileReadbackEvidence(value = []) {
    return (Array.isArray(value) ? value : [])
      .filter(item => item && typeof item.path === 'string')
      .map(item => ({
        path: item.path,
        state: ['match', 'mismatch', 'missing', 'unknown'].includes(item.state)
          ? item.state
          : 'unknown'
      }));
  }

  function deriveApplyResultReadbacks(applyResult = {}) {
    const readbacksByPath = new Map();
    const record = (path, state) => {
      if (typeof path !== 'string' || !path) return;
      const current = readbacksByPath.get(path);
      if (current === 'mismatch') return;
      if (state === 'mismatch' || !current) readbacksByPath.set(path, state);
    };
    for (const entry of [
      ...(Array.isArray(applyResult?.applied) ? applyResult.applied : []),
      ...(Array.isArray(applyResult?.skipped) ? applyResult.skipped : [])
    ]) {
      const operation = entry?.operation || {};
      const result = entry?.result || {};
      const code = result?.failure?.code || result?.code || '';
      const path = operation.type === 'rename' || operation.type === 'move'
        ? operation.to || operation.path
        : operation.path;
      if (code === 'write_observed_mismatch') {
        record(path, 'mismatch');
      } else if (result.verified === true) {
        record(path, operation.type === 'delete' ? 'missing' : 'match');
      }
    }
    return Array.from(readbacksByPath, ([path, state]) => ({ path, state }));
  }

  function deriveDocumentEffect(operationEvidence = []) {
    if (operationEvidence.some(entry => entry.changedDocument === true)) return 'changed';
    if (operationEvidence.some(entry => entry.mayHaveMutated === true)) return 'possibly-changed';
    if (operationEvidence.length) return 'unchanged';
    return 'unknown';
  }

  function deriveAppliedEvidence(operations = [], operationEvidence = []) {
    const plannedCount = Array.isArray(operations) ? operations.length : 0;
    const applied = operationEvidence.filter(entry => entry.collection === 'applied');
    const skipped = operationEvidence.filter(entry => entry.collection === 'skipped');
    const successful = applied.filter(entry => entry.ok !== false);
    if (!plannedCount && !operationEvidence.length) return 'none';
    if (!successful.length && (skipped.length || applied.some(entry => entry.ok === false))) return 'none';
    if (successful.length && (skipped.length || applied.some(entry => entry.ok === false))) return 'partial';
    if (successful.length && (!plannedCount || successful.length >= plannedCount)) return 'complete';
    return successful.length ? 'partial' : 'unknown';
  }

  function deriveReadbackEvidence(fileSettlements = [], readbacks = []) {
    if (!Array.isArray(readbacks) || !readbacks.length) return 'not-attempted';
    const states = fileSettlements.map(file => file.readBack);
    if (states.includes('mismatch')) return 'mismatch';
    const exactCount = states.filter(state => state === 'match').length;
    const unavailableCount = states.filter(state =>
      state === 'missing' || state === 'unknown'
    ).length;
    if (exactCount && unavailableCount) return 'partial';
    if (exactCount && exactCount === states.length) return 'exact';
    return 'unavailable';
  }

  return Object.freeze({
    aggregateFileSettlements,
    deriveAppliedEvidence,
    deriveApplyResultReadbacks,
    deriveDocumentEffect,
    deriveReadbackEvidence,
    normalizeFileReadbackEvidence
  });
});
