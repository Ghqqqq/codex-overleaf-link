(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafWritebackReceiptJournal = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create({ getProjectId, prepareEditor, applyOperations, now = Date.now,
    retentionMs = 600000, maxReceipts = 16 }) {
    const receipts = new Map();
    let active = null;
    const clone = value => JSON.parse(JSON.stringify(value));
    const empty = () => ({ applied: [], skipped: [], trackedChanges: [], trackedChangeCaptures: [] });
    function failure(code, error) { return { ok: false, code, error, changedDocument: false }; }
    function prune() {
      for (const [id, receipt] of receipts) {
        if (receipt.state === 'completed' && now() - receipt.updatedAt > retentionMs) receipts.delete(id);
      }
      while (receipts.size >= maxReceipts) {
        const oldest = Array.from(receipts).find(([, value]) => value.state === 'completed');
        if (!oldest) break;
        receipts.delete(oldest[0]);
      }
    }
    function snapshot(receipt) {
      const result = receipt.result || {
        ...receipt.partial,
        ok: receipt.partial.skipped.length === 0,
        trackedChanges: receipt.partial.trackedChangeCaptures.some(value => value.state !== 'observed')
          ? [] : receipt.partial.trackedChanges
      };
      return clone({ ok: true, requestId: receipt.id, runProjectId: receipt.projectId,
        state: receipt.state, updatedAt: receipt.updatedAt, result });
    }
    function get(params = {}) {
      if (!params.runProjectId || params.runProjectId !== getProjectId(params.runProjectId)) {
        return failure('writeback_receipt_scope_changed', 'The writeback project is no longer active.');
      }
      const receipt = receipts.get(params.requestId);
      if (!receipt || receipt.projectId !== params.runProjectId) {
        return failure('writeback_receipt_missing', 'The original writeback receipt is unavailable. Do not replay the write.');
      }
      return snapshot(receipt);
    }
    async function apply(params = {}) {
      const id = params.writebackRequestId, projectId = params.runProjectId;
      if (typeof id !== 'string' || !id || id.length > 160 || !projectId || projectId !== getProjectId(projectId)) {
        return failure('writeback_receipt_identity_invalid', 'Writeback request identity could not be confirmed.');
      }
      const fingerprint = JSON.stringify(params.operations || []);
      const previous = receipts.get(id);
      if (previous) {
        if (previous.projectId !== projectId || previous.fingerprint !== fingerprint) {
          return failure('writeback_receipt_conflict', 'The writeback request ID was reused with different operations.');
        }
        return previous.promise; // Duplicate delivery retrieves the original work; it never executes it again.
      }
      if (active) return failure('writeback_in_progress', 'An earlier writeback is still running. Wait for its result before writing again.');
      prune();
      const receipt = { id, projectId, fingerprint, state: 'running', updatedAt: now(), partial: empty() };
      receipts.set(id, receipt);
      active = receipt;
      const onOperationResult = ({ operation, result }) => {
        const entry = clone({ operation, result });
        (result.ok ? receipt.partial.applied : receipt.partial.skipped).push(entry);
        if (operation.type === 'edit' && result.ok && Array.isArray(result.trackedChanges)) {
          receipt.partial.trackedChanges.push(...clone(result.trackedChanges));
        }
        if (result.trackedChangeCapture) receipt.partial.trackedChangeCaptures.push(clone(result.trackedChangeCapture));
        receipt.updatedAt = now();
      };
      // Defer execution until the promise is assigned, including for immediately completed operations.
      receipt.promise = Promise.resolve().then(async () => {
        if (params.reviewingPolicy === 'no-trace-undo') {
          const prepared = await prepareEditor(params);
          if (prepared.ok !== true) return { applied: [], changedDocument: false,
            skipped: (params.operations || []).map(operation => ({ operation, result: prepared })) };
        }
        return applyOperations(params.operations || [], {
          baseFiles: params.baseFiles || null,
          reviewingPolicy: params.reviewingPolicy || '',
          requireReviewing: params.requireReviewing === true,
          requireEditing: params.requireEditing === true,
          runProjectId: projectId,
          onOperationResult
        });
      }).catch(error => ({
        ...snapshot(receipt).result, ok: false, code: error?.code || 'page_bridge_dispatch_failed',
        error: error?.message || String(error), requestId: id, changedDocument: true
      })).then(result => {
        receipt.result = clone(result && typeof result === 'object' ? result
          : { ok: false, code: 'writeback_result_unconfirmed', error: 'The page returned no writeback result.' });
        receipt.state = 'completed';
        receipt.updatedAt = now();
        if (active === receipt) active = null;
        return receipt.result;
      });
      return receipt.promise;
    }
    return Object.freeze({ apply, get });
  }
  return { create };
});
